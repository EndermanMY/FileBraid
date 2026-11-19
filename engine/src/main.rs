use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
};
mod transfer;
mod checksum;
mod copy_settings;
mod copy_operation;
mod file_lists;
mod sony;
use checksum::Algorithm;
use copy_settings::{CopySettings, Mode};

#[derive(Deserialize)]
struct Workflow {
    version: u32,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    #[serde(default)]
    parameters: HashMap<String, String>,
}

#[derive(Deserialize)]
struct Node {
    id: String,
    kind: Kind,
    value: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Source,
    Tree,
    Outputtree,
    Merge,
    Subtract,
    Camera,
    Filter,
    Directory,
    Target,
    Copy,
    Sha256,
    Crc32,
    Blake3,
    Md5,
    Sha1,
    Xxh3,
    Fastcopy,
    Standardcopy,
}

impl Kind {
    fn algorithm(self) -> Option<Algorithm> {
        Some(match self {
            Self::Sha256 => Algorithm::Sha256,
            Self::Crc32 => Algorithm::Crc32,
            Self::Blake3 => Algorithm::Blake3,
            Self::Md5 => Algorithm::Md5,
            Self::Sha1 => Algorithm::Sha1,
            Self::Xxh3 => Algorithm::Xxh3,
            _ => return None,
        })
    }
}
#[derive(Deserialize)]
struct Edge {
    source: String,
    target: String,
    #[serde(default, rename = "sourceHandle")]
    source_handle: Option<String>,
    #[serde(default, rename = "targetHandle")]
    target_handle: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ModificationTime(std::time::SystemTime);

impl Serialize for ModificationTime {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0.duration_since(std::time::UNIX_EPOCH) {
            Ok(_) => self.0.serialize(serializer),
            Err(before_epoch) => {
                #[derive(Serialize)]
                struct BeforeEpoch {
                    secs_before_epoch: u64,
                    nanos_before_epoch: u32,
                }
                let duration = before_epoch.duration();
                BeforeEpoch { secs_before_epoch: duration.as_secs(), nanos_before_epoch: duration.subsec_nanos() }
                    .serialize(serializer)
            }
        }
    }
}

#[derive(Serialize)]
struct Row {
    source: PathBuf,
    destination: PathBuf,
    bytes: u64,
    category: &'static str,
    verified_by: Vec<Algorithm>,
    verify_timing: Option<VerifyTiming>,
    copy_settings: Option<CopySettings>,
    copy_mode: Option<Mode>,
    existing: bool,
    root: PathBuf,
    target: String,
    modified: ModificationTime,
}

#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum VerifyTiming { PerFile, AfterCopy }

#[derive(Serialize)]
struct Plan {
    rows: Vec<Row>,
    excluded: Vec<PathBuf>,
    fingerprint: String,
    source_fingerprint: String,
}

#[derive(Deserialize)]
struct Execution {
    workflow: Workflow,
    fingerprint: String,
}
fn error(path: &Path, cause: io::Error) -> String {
    format!("{}：{cause}", path.display())
}

fn key(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) { value.to_lowercase() } else { value.into_owned() }
}

fn root(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(format!("请选择绝对目录路径：{}", path.display()));
    }
    let canonical = path.canonicalize().map_err(|cause| error(path, cause))?;
    if !canonical.is_dir() {
        return Err(format!("不是目录：{}", path.display()));
    }
    Ok(canonical)
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn scan(dir: &Path, files: &mut Vec<(PathBuf, u64, ModificationTime)>) -> Result<(), String> {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(&path).map_err(|cause| error(&path, cause))? {
            let entry = entry.map_err(|cause| error(&path, cause))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|cause| error(&path, cause))?;
            if is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
                return Err(format!("来源含链接或特殊文件：{}", path.display()));
            }
            if metadata.is_dir() {
                pending.push(path);
            } else {
                let modified = metadata.modified().map_err(|cause| error(&path, cause))?;
                files.push((path, metadata.len(), ModificationTime(modified)));
                if files.len() > 20_000 {
                    return Err("当前预览最多支持 20,000 个源文件。".into());
                }
            }
        }
    }
    files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    Ok(())
}

fn component_allowed(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix)
                .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))
        });
    !device && !value.is_empty() && !value.ends_with(['.', ' '])
        && !value.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
}

fn expand_component(template: &str, parameters: &HashMap<String, String>) -> Result<String, String> {
    let mut result = String::new();
    let mut remaining = template;
    while let Some((prefix, variable)) = remaining.split_once('{') {
        if prefix.contains('}') { return Err("目录模板的大括号不匹配。".into()); }
        let (name, suffix) = variable.split_once('}').ok_or("目录模板缺少右大括号。")?;
        if !matches!(name, "项目" | "日期" | "机位" | "卡次") {
            return Err(format!("不支持的目录变量：{name}"));
        }
        let value = parameters.get(name).filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("请填写任务参数：{name}"))?;
        if !component_allowed(value) {
            return Err(format!("任务参数含无效的目录名称：{name}"));
        }
        result.push_str(prefix);
        result.push_str(value);
        remaining = suffix;
    }
    if remaining.contains('}') { return Err("目录模板的大括号不匹配。".into()); }
    result.push_str(remaining);
    if !component_allowed(&result) {
        return Err(format!("目录模板含无效名称：{result}"));
    }
    Ok(result)
}

fn target_path(root: &Path, relative: &Path) -> Result<(PathBuf, bool), String> {
    let mut path = root.to_path_buf();
    let mut parts = relative.iter().peekable();
    let mut exists = false;
    while let Some(part) = parts.next() {
        let name = part.to_str().ok_or("目标路径不是有效的 Unicode。")?;
        if !component_allowed(name) {
            return Err(format!("目标路径含无效名称：{name}"));
        }
        path.push(part);
        exists = match fs::symlink_metadata(&path) {
            Ok(meta) if !is_link(&meta) && if parts.peek().is_some() { meta.is_dir() } else { meta.is_file() } => true,
            Ok(_) => return Err(format!("目标路径与链接或已有文件夹结构冲突：{}", path.display())),
            Err(cause) if cause.kind() == io::ErrorKind::NotFound => false,
            Err(cause) => return Err(error(&path, cause)),
        };
    }
    Ok((path, exists))
}

fn disk_folder(relative: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::new();
    for part in relative.split('/') {
        if !component_allowed(part) { return Err("输出目录树含无效的文件夹路径。".into()); }
        path.push(part);
    }
    Ok(path)
}

fn check_disk_folder(root: &Path, relative: &Path) -> Result<(), String> {
    let mut path = root.to_path_buf();
    for part in relative {
        path.push(part);
        let valid = fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir() && !is_link(&meta));
        if !valid { return Err(format!("请选择仍存在的输出文件夹：{}", path.display())); }
    }
    Ok(())
}

fn plan(mut workflow: Workflow) -> Result<Plan, String> {
    let limits = match workflow.version { 1 => (100, 200), 2 | 3 => (101, 300), 4 => (202, 401), _ => (0, 0) };
    if limits.0 == 0 || workflow.nodes.len() > limits.0 || workflow.edges.len() > limits.1 {
        return Err("工作流版本或大小不受支持。".into());
    }
    let ids: HashSet<_> = workflow.nodes.iter().map(|node| node.id.as_str()).collect();
    if ids.len() != workflow.nodes.len() || ids.contains("") {
        return Err("工作流含无效或重复的节点编号。".into());
    }
    if workflow.version == 4 {
        copy_operation::bind_targets(&mut workflow)?;
    } else if workflow.nodes.iter().any(|node| node.kind == Kind::Copy) {
        return Err("「复制」需要第 4 版工作流。".into());
    }
    let nodes: HashMap<_, _> = workflow.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut inputs: HashMap<&str, Vec<&Edge>> = HashMap::new();
    let mut checks: HashMap<&str, BTreeSet<Algorithm>> = HashMap::new();
    let mut verification_timing = HashMap::new();
    let mut strategies = HashMap::new();
    for edge in &workflow.edges {
        let source = nodes.get(edge.source.as_str()).ok_or("连线来源不存在。")?;
        let target = nodes.get(edge.target.as_str()).ok_or("连线目标不存在。")?;
        if matches!(source.kind, Kind::Fastcopy | Kind::Standardcopy) {
            if target.kind != Kind::Target || (workflow.version >= 2 &&
                (edge.source_handle.as_deref().unwrap_or("out") != "out" ||
                    edge.target_handle.as_deref().unwrap_or("transfer") != "transfer")) {
                return Err("复制策略必须连接到相应的复制策略端口。".into());
            }
            let settings = if source.kind == Kind::Fastcopy { Some(CopySettings::parse(&source.value)?) } else { None };
            if strategies.insert(target.id.as_str(), settings).is_some() {
                return Err("每项复制只能使用一种复制策略。".into());
            }
            continue;
        }
        if let Some(algorithm) = source.kind.algorithm() {
            if target.kind != Kind::Target || !checks.entry(&target.id).or_default().insert(algorithm) {
                return Err("校验策略只能连接复制目标，每种算法只需连接一次。".into());
            }
            let timing = match source.value.as_str() {
                "" | "per_file" => VerifyTiming::PerFile,
                "after_copy" => VerifyTiming::AfterCopy,
                _ => return Err("校验时机无效，请重新选择。".into()),
            };
            let previous = verification_timing.entry(target.id.as_str()).or_insert(timing);
            if *previous != timing {
                return Err("同一目标的校验节点必须使用相同的校验时机。".into());
            }
            continue;
        }
        if !matches!(source.kind, Kind::Source | Kind::Tree | Kind::Outputtree | Kind::Camera | Kind::Filter | Kind::Directory | Kind::Merge | Kind::Subtract)
            || !matches!(target.kind, Kind::Tree | Kind::Outputtree | Kind::Camera | Kind::Filter | Kind::Directory | Kind::Merge | Kind::Subtract | Kind::Target) {
            return Err("工作流含无效的文件连线。".into());
        }
        if target.kind == Kind::Tree && (source.kind != Kind::Source || edge.source_handle.as_deref().unwrap_or("out") != "out") {
            return Err("「来源目录树」的「文件」端口只能连接「源目录」。".into());
        }
        let port = edge.target_handle.as_deref().unwrap_or("files");
        if port != "files" && !(target.kind == Kind::Subtract && port == "exclude")
            && !(target.kind == Kind::Outputtree && (port.starts_with("folder:") || port.starts_with("disk:"))) {
            return Err("无效的文件输入端口。".into());
        }
        let incoming = inputs.entry(target.id.as_str()).or_default();
        if !matches!(target.kind, Kind::Merge | Kind::Outputtree)
            && incoming.iter().any(|other| other.target_handle.as_deref().unwrap_or("files") == port) {
            return Err("此端口只能连接一条文件清单。".into());
        }
        incoming.push(edge);
    }
    for node in workflow.nodes.iter().filter(|node| node.kind == Kind::Outputtree) {
        let mut selected = inputs.get(node.id.as_str()).into_iter().flatten().filter_map(|edge|
            edge.target_handle.as_deref().and_then(|handle| handle.strip_prefix("disk:"))).peekable();
        if selected.peek().is_none() { continue; }
        let mut outgoing = workflow.edges.iter().filter(|edge| edge.source == node.id);
        let target = outgoing.next().map(|edge| nodes[edge.target.as_str()]);
        let Some(target) = target.filter(|target| target.kind == Kind::Target && outgoing.next().is_none()) else {
            return Err(if workflow.version == 4 {
                "使用实际输出文件夹时，请将「目标目录树」通过「复制」连接一个「目标目录」。"
            } else {
                "使用实际输出文件夹时，请将「目标目录树」直接连接一个「文件输出」。"
            }.into());
        };
        let target_root = root(&target.value)?;
        for relative in selected {
            check_disk_folder(&target_root, &disk_folder(relative)?)?;
        }
    }
    fn check_cycles<'a>(id: &'a str, inputs: &HashMap<&'a str, Vec<&'a Edge>>, visiting: &mut HashSet<&'a str>,
        checked: &mut HashSet<&'a str>) -> Result<(), String> {
        if checked.contains(id) { return Ok(()); }
        if !visiting.insert(id) { return Err("工作流不能包含循环。".into()); }
        for edge in inputs.get(id).into_iter().flatten() {
            check_cycles(&edge.source, inputs, visiting, checked)?;
        }
        visiting.remove(id);
        checked.insert(id);
        Ok(())
    }
    let mut checked = HashSet::new();
    let mut visiting = HashSet::new();
    for id in nodes.keys() { check_cycles(id, &inputs, &mut visiting, &mut checked)?; }
    let mut rows = Vec::new();
    let mut mapped = HashMap::new();
    let legacy_parameters = (workflow.version < 3).then_some(&workflow.parameters);
    let mut lists = file_lists::FileLists::new(&nodes, &inputs, legacy_parameters);
    for target in workflow.nodes.iter().filter(|node| node.kind == Kind::Target) {
        let copy_settings = match strategies.get(target.id.as_str()) {
            Some(settings) => *settings,
            None if workflow.version == 1 => None,
            None if workflow.version == 4 => return Err("请为每个「复制」连接一种复制策略：标准复制策略或流复制策略。".into()),
            None => return Err("请为每个「文件输出」连接一种复制策略：标准复制策略或流复制策略。".into()),
        };
        let files = lists.target_files(&target.id)?;
        let destination = root(&target.value)?;
        let destination_key = PathBuf::from(key(&destination));
        let mut modes = HashMap::new();
        for item in files.iter() {
            let source_key = PathBuf::from(key(&item.root));
            if source_key.starts_with(&destination_key) || destination_key.starts_with(&source_key) {
                return Err("来源和目标目录不能重叠。".into());
            }
            let copy_mode = *modes.entry(&item.root).or_insert_with(|| copy_settings.map(|settings| settings.effective_mode(&item.root, &destination)));
            let (path, existing) = target_path(&destination, &item.output)?;
            let verified_by: Vec<_> = checks.get(target.id.as_str()).into_iter().flatten().copied().collect();
            let verify_timing = verification_timing.get(target.id.as_str()).copied();
            match mapped.entry(key(&path)) {
                std::collections::hash_map::Entry::Occupied(entry) => {
                    if entry.get() != &(item.path.clone(), verified_by.clone(), copy_settings, verify_timing) {
                        return Err(format!("来源或校验规则冲突：{}", path.display()));
                    }
                    continue;
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert((item.path.clone(), verified_by.clone(), copy_settings, verify_timing));
                }
            }
            rows.push(Row {
                source: item.path.clone(),
                destination: path,
                bytes: item.bytes,
                category: item.camera.map_or("文件", sony::Category::label),
                verified_by,
                verify_timing,
                copy_settings,
                copy_mode,
                existing,
                root: destination.clone(),
                target: target.id.clone(),
                modified: item.modified,
            });
            if rows.len() > 40_000 {
                return Err("当前预览最多支持 40,000 条输出。".into());
            }
        }
    }
    if !workflow.nodes.iter().any(|node| node.kind == Kind::Target) {
        return Err("请添加复制目标。".into());
    }
    for row in &rows {
        if let Some(parent) = row.destination.ancestors().skip(1).find(|parent| mapped.contains_key(&key(parent))) {
            return Err(format!("输出文件与另一个输出的目录冲突：{}", parent.display()));
        }
    }
    for row in &rows {
        if lists.scans.keys().any(|source| Path::new(&key(&row.destination)).starts_with(key(source))) {
            return Err("输出不能写入此工作流中的任何来源目录。".into());
        }
    }
    let inventory: std::collections::BTreeMap<_, _> = lists.scans.into_iter().collect();
    let routed: HashSet<_> = rows.iter().map(|row| &row.source).collect();
    lists.excluded.extend(lists.sony_split_sources.into_iter().filter(|path| !routed.contains(path)));
    let excluded: Vec<_> = lists.excluded.into_iter().collect();
    let source_contents = serde_json::to_vec(&inventory).map_err(|cause| cause.to_string())?;
    let source_fingerprint = format!("{:x}", Sha256::digest(source_contents));
    let contents = serde_json::to_vec(&(&rows, &excluded, &source_fingerprint)).map_err(|cause| cause.to_string())?;
    let fingerprint = format!("{:x}", Sha256::digest(contents));
    Ok(Plan { rows, excluded, fingerprint, source_fingerprint })
}

fn run() -> Result<(), String> {
    let mut input = Vec::new();
    let mode = std::env::args().nth(1);
    let verify_only = mode.as_deref() == Some("verify");
    let execution = verify_only || mode.as_deref() == Some("execute");
    let stdin = io::stdin();
    if execution {
        stdin.lock().take(1_000_001).read_until(b'\n', &mut input).map_err(|cause| cause.to_string())?;
    } else {
        stdin.lock().take(1_000_001).read_to_end(&mut input).map_err(|cause| cause.to_string())?;
    }
    if input.len() > 1_000_000 {
        return Err("工作流超过 1 MB。".into());
    }
    let output = if mode.as_deref() == Some("sony-structure") {
        #[derive(Deserialize)]
        struct Source {
            folder: String,
            output: String,
        }
        let source: Source = serde_json::from_slice(&input).map_err(|cause| cause.to_string())?;
        serde_json::to_value(file_lists::probe_sony(&source.folder, &source.output)?)
    } else if execution {
        let request: Execution = serde_json::from_slice(&input).map_err(|cause| cause.to_string())?;
        let plan = plan(request.workflow)?;
        if plan.fingerprint != request.fingerprint {
            return Err("来源或目标已变化，请重新预览。".into());
        }
        let stopped = std::sync::Arc::new(transfer::TransferControl::default());
        let monitor = stopped.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match io::stdin().read_line(&mut line) {
                    Ok(count) if count > 0 => match line.trim() {
                        "pause" => monitor.pause(),
                        "resume" => monitor.resume(),
                        _ => break,
                    },
                    _ => break,
                }
            }
            monitor.cancel();
        });
        let excluded = plan.excluded.clone();
        let emit = |event: &dyn Fn(&mut io::StderrLock<'_>)| {
            let mut stderr = io::stderr().lock();
            event(&mut stderr);
            let _ = writeln!(stderr);
        };
        let outcomes = transfer::execute(plan, &stopped, verify_only, |outcome| {
            emit(&|stderr| { let _ = serde_json::to_writer(stderr, outcome); });
        }, |progress| {
            emit(&|stderr| { let _ = serde_json::to_writer(stderr, progress); });
        });
        serde_json::to_value(serde_json::json!({ "outcomes": outcomes, "excluded": excluded }))
    } else {
        let workflow = serde_json::from_slice(&input).map_err(|cause| format!("工作流格式错误：{cause}"))?;
        serde_json::to_value(plan(workflow)?)
    }.map_err(|cause| cause.to_string())?;
    serde_json::to_writer(io::stdout().lock(), &output).map_err(|cause| cause.to_string())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
