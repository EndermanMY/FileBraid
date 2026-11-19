use std::collections::{HashMap, HashSet};

use crate::{Kind, Workflow};

pub(crate) fn bind_targets(workflow: &mut Workflow) -> Result<(), String> {
    let kinds: HashMap<_, _> = workflow
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node.kind))
        .collect();
    let mut targets = HashSet::new();
    let mut copies = HashMap::new();

    for edge in &workflow.edges {
        let source = *kinds.get(edge.source.as_str()).ok_or("连线来源不存在。")?;
        let target = *kinds.get(edge.target.as_str()).ok_or("连线目标不存在。")?;
        if source == Kind::Copy || target == Kind::Target {
            if source != Kind::Copy
                || target != Kind::Target
                || edge.source_handle.as_deref().unwrap_or("out") != "out"
                || edge.target_handle.as_deref().unwrap_or("operation") != "operation"
            {
                return Err("「复制」的「输出文件」须连接「目标目录」的「文件」端口。".into());
            }
            if copies.insert(edge.source.clone(), edge.target.clone()).is_some()
                || !targets.insert(edge.target.clone())
            {
                return Err("每个「复制」只能连接一个「目标目录」，每个「目标目录」只接收一路文件。".into());
            }
        } else if target == Kind::Copy {
            let expected = if matches!(source, Kind::Standardcopy | Kind::Fastcopy) {
                "transfer"
            } else if source.algorithm().is_some() {
                "verify"
            } else {
                "files"
            };
            if edge.target_handle.as_deref().unwrap_or(expected) != expected
                || (expected != "files" && edge.source_handle.as_deref().unwrap_or("out") != "out")
            {
                return Err("请将文件、复制策略和校验策略连接到「复制」的对应端口。".into());
            }
        }
    }

    if kinds.iter().any(|(id, kind)| *kind == Kind::Copy && !copies.contains_key(*id)) {
        return Err("请为每个「复制」连接一个「目标目录」。".into());
    }
    if kinds.iter().any(|(id, kind)| *kind == Kind::Target && !targets.contains(*id)) {
        return Err("请将「复制」的「输出文件」连接到「目标目录」的「文件」端口。".into());
    }

    // Bind each operation to its destination before evaluating file lists and building plan rows.
    // The target ID and the order of all file inputs stay stable for task reports and recovery.
    workflow.edges.retain_mut(|edge| {
        if copies.contains_key(&edge.source) {
            return false;
        }
        if let Some(destination) = copies.get(&edge.target) {
            if edge.target_handle.is_none() {
                let source = kinds[edge.source.as_str()];
                if source.algorithm().is_some() {
                    edge.target_handle = Some("verify".into());
                } else if matches!(source, Kind::Fastcopy | Kind::Standardcopy) {
                    edge.target_handle = Some("transfer".into());
                }
            }
            edge.target.clone_from(destination);
        }
        true
    });
    workflow.nodes.retain(|node| node.kind != Kind::Copy);
    Ok(())
}
