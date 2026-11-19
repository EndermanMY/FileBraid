use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "filebraid-copy-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn engine(args: &[&str], value: &Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_filebraid-engine"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{value}").unwrap();
    if !matches!(args.first(), Some(&"execute" | &"verify")) {
        drop(stdin);
        child.wait_with_output().unwrap()
    } else {
        let result = child.wait_with_output().unwrap();
        drop(stdin);
        result
    }
}

fn ok(output: Output) -> Value {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

fn node(id: &str, kind: &str, value: &str) -> Value {
    json!({ "id": id, "kind": kind, "value": value })
}

fn edge(source: &str, target: &str, port: &str) -> Value {
    json!({ "source": source, "target": target, "targetHandle": port })
}

#[test]
fn copy_operation_preserves_paths_strategies_and_fingerprints() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    let target = fixture.0.join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir_all(target.join("photos")).unwrap();
    fs::write(source.join("clip.txt"), b"abc").unwrap();
    let nodes = vec![
        node("source", "source", source.to_str().unwrap()),
        node("routes", "outputtree", ""),
        node("standard", "standardcopy", ""),
        node("hash", "sha256", "after_copy"),
        node("target", "target", target.to_str().unwrap()),
    ];
    let old = json!({ "version": 3, "nodes": nodes, "edges": [
        edge("source", "routes", "disk:photos"),
        edge("routes", "target", "files"),
        edge("standard", "target", "transfer"),
        edge("hash", "target", "verify"),
    ] });
    let mut nodes = nodes;
    nodes.push(node("copy", "copy", ""));
    let new = json!({ "version": 4, "nodes": nodes, "edges": [
        edge("source", "routes", "disk:photos"),
        edge("routes", "copy", "files"),
        edge("standard", "copy", "transfer"),
        edge("hash", "copy", "verify"),
        edge("copy", "target", "operation"),
    ] });
    let expected = ok(engine(&[], &old));
    assert_eq!(expected["rows"][0]["verify_timing"], "after_copy");
    assert_eq!(ok(engine(&[], &new)), expected);
}

#[test]
fn copy_operation_executes_and_verifies_the_written_file() {
    let fixture = Fixture::new();
    let source = fixture.0.join("source");
    let destination = fixture.0.join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(source.join("clip.txt"), b"abc").unwrap();
    let workflow = json!({ "version": 4, "nodes": [
        node("source", "source", source.to_str().unwrap()),
        node("standard", "standardcopy", ""),
        node("hash", "sha256", ""),
        node("copy", "copy", ""),
        node("target", "target", destination.to_str().unwrap()),
    ], "edges": [
        edge("source", "copy", "files"),
        edge("standard", "copy", "transfer"),
        edge("hash", "copy", "verify"),
        edge("copy", "target", "operation"),
    ] });
    let plan = ok(engine(&[], &workflow));
    let result = ok(engine(&["execute"], &json!({ "workflow": workflow, "fingerprint": plan["fingerprint"] })));
    assert_eq!(result["outcomes"][0]["status"], "verified");
    let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    for name in ["source_checksums", "target_checksums"] {
        assert!(result["outcomes"][0][name].as_object().unwrap().values().any(|value| value == digest));
    }
    assert_eq!(fs::read(destination.join("clip.txt")).unwrap(), b"abc");
}

#[test]
fn a_copy_operation_cannot_feed_multiple_targets() {
    let workflow = json!({ "version": 4, "nodes": [
        node("copy", "copy", ""),
        node("a", "target", ""),
        node("b", "target", ""),
    ], "edges": [
        edge("copy", "a", "operation"),
        edge("copy", "b", "operation"),
    ] });
    let output = engine(&[], &workflow);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("每个「复制」只能连接一个「目标目录」"));
}


#[test]
fn sony_outputs_route_card_files_and_keep_matching_companions() {
    let fixture = Fixture::new();
    let source = fixture.0.join("card");
    let destination = fixture.0.join("target");
    fs::create_dir(&destination).unwrap();
    let expected = [
        ("DCIM/100MSDCF/A.ARW", "photos"),
        ("DCIM/100MSDCF/A.JPG", "photos"),
        ("PRIVATE/M4ROOT/CLIP/A.MP4", "videos"),
        ("PRIVATE/M4ROOT/CLIP/aM01.XML", "videos"),
        ("PRIVATE/M4ROOT/THMBNL/AT01.JPG", "videos"),
        ("M4ROOT/CLIP/B.MXF", "videos"),
        ("PRIVATE/AVCHD/BDMV/STREAM/00001.MTS", "videos"),
        ("PRIVATE/M4ROOT/SUB/AS03.MP4", "proxies"),
        ("PRIVATE/M4ROOT/SUB/AS03M01.XML", "proxies"),
        ("PRIVATE/M4ROOT/THMBNL/OrphanT01.JPG", "management"),
        ("PRIVATE/M4ROOT/CLIP/OrphanM01.XML", "management"),
        ("PRIVATE/M4ROOT/MEDIAPRO.XML", "management"),
        ("PRIVATE/AVCHD/BDMV/INDEX.BDM", "management"),
        ("PRIVATE/DATABASE/DATABASE.BIN", "management"),
        ("PRIVATE/SONY/SONYCARD.IND", "management"),
        ("PRIVATE/SONY/PRO/LUT/look.cube", "luts"),
        ("PRIVATE/M4ROOT/CLIP/._A.MP4", "other"),
        ("other/A.MP4", "other"),
    ];
    for (relative, _) in expected {
        let path = source.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, relative.as_bytes()).unwrap();
    }
    let marker = fs::File::options().write(true).open(source.join("PRIVATE/SONY/SONYCARD.IND")).unwrap();
    let old_timestamp = std::time::UNIX_EPOCH - std::time::Duration::from_secs(1);
    marker.set_times(fs::FileTimes::new().set_modified(old_timestamp)).unwrap();
    drop(marker);
    let categories = ["photos", "videos", "proxies", "management", "luts", "other"];
    let folders: Vec<_> = categories.iter().map(|id| json!({ "id": id, "name": id })).collect();
    let mut workflow = json!({ "version": 4, "nodes": [
        node("source", "source", source.to_str().unwrap()),
        node("camera", "camera", ""),
        node("routes", "outputtree", &json!(folders).to_string()),
        node("standard", "standardcopy", ""),
        node("copy", "copy", ""),
        node("target", "target", destination.to_str().unwrap()),
    ], "edges": [
        edge("source", "camera", "files"), edge("routes", "copy", "files"),
        edge("standard", "copy", "transfer"), edge("copy", "target", "operation"),
    ] });
    let edges = workflow["edges"].as_array_mut().unwrap();
    let base = edges.len();
    for id in categories {
        edges.push(json!({ "source": "camera", "sourceHandle": format!("sony:{id}"),
            "target": "routes", "targetHandle": format!("folder:{id}") }));
    }
    assert_eq!(ok(engine(&["sony-structure"], &json!({ "folder": source, "output": "out" }))), json!(true));
    assert_eq!(ok(engine(&["sony-structure"], &json!({ "folder": destination, "output": "out" }))), json!(false));
    let plan = ok(engine(&[], &workflow));
    assert_eq!(plan["rows"].as_array().unwrap().len(), expected.len());
    assert_eq!(plan["excluded"], json!([]));
    ok(engine(&["execute"], &json!({ "workflow": workflow, "fingerprint": plan["fingerprint"] })));
    for (relative, category) in expected {
        assert_eq!(fs::read(destination.join(category).join(relative)).unwrap(), relative.as_bytes());
    }

    let edges = workflow["edges"].as_array_mut().unwrap();
    edges.truncate(base);
    edges.push(json!({ "source": "camera", "sourceHandle": "sony:videos",
        "target": "routes", "targetHandle": "folder:videos" }));
    let plan = ok(engine(&[], &workflow));
    let videos = expected.iter().filter(|(_, category)| *category == "videos").count();
    assert_eq!(plan["rows"].as_array().unwrap().len(), videos);
    assert_eq!(plan["excluded"].as_array().unwrap().len(), expected.len() - videos);

    workflow["edges"].as_array_mut().unwrap()[base] = edge("camera", "routes", "files");
    let full = ok(engine(&[], &workflow));
    assert_eq!(full["rows"].as_array().unwrap().len(), expected.len());
    assert_eq!(full["excluded"], json!([]));
    fs::remove_file(source.join("PRIVATE/SONY/SONYCARD.IND")).unwrap();
    let generic = engine(&[], &workflow);
    assert!(!generic.status.success());
    assert!(String::from_utf8_lossy(&generic.stderr).contains("未识别到 Sony 相机结构"));
    fs::write(source.join("PRIVATE/M4ROOT/CLIP/aM01.XML"),
        br#"<NonRealTimeMeta><Device manufacturer="Sony" modelName="ILME-FX3"/></NonRealTimeMeta>"#).unwrap();
    assert_eq!(ok(engine(&[], &workflow))["rows"].as_array().unwrap().len(), expected.len() - 1);
    workflow["edges"][base]["sourceHandle"] = json!("sony:typo");
    let invalid = engine(&[], &workflow);
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("无效的文件输出端口"));
}
