use super::{component_allowed, disk_folder, error, expand_component, is_link, key, root, scan, sony, Edge, Kind, ModificationTime, Node};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    rc::Rc,
};

#[derive(Clone)]
pub struct Item {
    pub path: PathBuf,
    pub root: PathBuf,
    pub output: PathBuf,
    pub relative: PathBuf,
    selection_parent: PathBuf,
    pub bytes: u64,
    pub modified: ModificationTime,
    pub camera: Option<sony::Category>,
    filtered: bool,
}

type Inventory = Vec<(PathBuf, u64, ModificationTime)>;
type List = Rc<Vec<Item>>;

#[derive(serde::Deserialize)]
struct OutputFolder {
    id: String,
    parent: Option<String>,
    name: String,
}

pub(crate) fn probe_sony(folder: &str, output: &str) -> Result<bool, String> {
    if output != "out" && !output.starts_with("item:") { return Err("无效的文件输出端口。".into()); }
    let nodes = HashMap::new();
    let inputs = HashMap::new();
    let mut lists = FileLists::new(&nodes, &inputs, None);
    let files = lists.source(folder, output)?;
    match sony::classify(&files) {
        Ok(_) => Ok(true),
        Err(error) if error == sony::UNRECOGNIZED => Ok(false),
        Err(error) => Err(error),
    }
}

pub struct FileLists<'a> {
    nodes: &'a HashMap<&'a str, &'a Node>,
    inputs: &'a HashMap<&'a str, Vec<&'a Edge>>,
    legacy_parameters: Option<&'a HashMap<String, String>>,
    visiting: HashSet<&'a str>,
    cached: HashMap<(&'a str, &'a str), List>,
    cached_items: usize,
    pub scans: HashMap<PathBuf, Inventory>,
    pub excluded: BTreeSet<PathBuf>,
    pub sony_split_sources: BTreeSet<PathBuf>,
}

impl<'a> FileLists<'a> {
    pub fn new(nodes: &'a HashMap<&'a str, &'a Node>, inputs: &'a HashMap<&'a str, Vec<&'a Edge>>,
        legacy_parameters: Option<&'a HashMap<String, String>>) -> Self {
        Self { nodes, inputs, legacy_parameters, visiting: HashSet::new(), cached: HashMap::new(),
            cached_items: 0, scans: HashMap::new(), excluded: BTreeSet::new(), sony_split_sources: BTreeSet::new() }
    }

    fn folder_name(&self, name: &str) -> Result<String, String> {
        if let Some(parameters) = self.legacy_parameters { return expand_component(name, parameters); }
        if !component_allowed(name) { return Err(format!("无效的文件夹名称：{name}")); }
        Ok(name.to_owned())
    }

    pub fn target_files(&mut self, id: &'a str) -> Result<List, String> {
        self.input(id, "files")?.ok_or_else(|| "复制缺少要写入的文件，请检查上游连线。".into())
    }

    fn input(&mut self, id: &'a str, port: &str) -> Result<Option<List>, String> {
        let edge = self.inputs.get(id).into_iter().flatten()
            .find(|edge| edge.target_handle.as_deref().unwrap_or("files") == port).copied();
        edge.map(|edge| self.read_edge(edge)).transpose()
    }

    fn read_edge(&mut self, edge: &'a Edge) -> Result<List, String> {
        let output = edge.source_handle.as_deref().unwrap_or("out");
        let node = self.nodes[edge.source.as_str()];
        let valid = output == "out" || (node.kind == Kind::Tree && output.starts_with("item:"))
            || (node.kind == Kind::Camera && sony::Category::from_handle(output).is_some());
        if !valid {
            return Err("无效的文件输出端口。".into());
        }
        let cache_key = (node.id.as_str(), output);
        if let Some(list) = self.cached.get(&cache_key) { return Ok(list.clone()); }
        if !self.visiting.insert(&node.id) { return Err("工作流不能包含循环。".into()); }
        let result = self.evaluate(node, output);
        self.visiting.remove(node.id.as_str());
        let list = Rc::new(result?);
        self.cached_items += list.len();
        if list.len() > 40_000 || self.cached_items > 250_000 {
            return Err("工作流文件清单过大，请缩小扫描范围或减少分支。".into());
        }
        self.cached.insert(cache_key, list.clone());
        Ok(list)
    }

    fn source(&mut self, folder: &str, output: &str) -> Result<Vec<Item>, String> {
        let base = root(folder)?;
        let mut selected = base.clone();
        if let Some(relative) = output.strip_prefix("item:") {
            for part in relative.split('/') {
                if !component_allowed(part) { return Err("目录树端口含无效路径。".into()); }
                selected.push(part);
                let metadata = fs::symlink_metadata(&selected).map_err(|cause| error(&selected, cause))?;
                if is_link(&metadata) { return Err("目录树端口不能指向链接。".into()); }
            }
        }
        if !self.scans.contains_key(&selected) {
            if self.scans.values().map(Vec::len).sum::<usize>() >= 100_000 {
                return Err("工作流扫描范围过大。".into());
            }
            let mut files = Vec::new();
            let metadata = fs::symlink_metadata(&selected).map_err(|cause| error(&selected, cause))?;
            if metadata.is_dir() { scan(&selected, &mut files)?; }
            else if metadata.is_file() {
                files.push((selected.clone(), metadata.len(), ModificationTime(metadata.modified().map_err(|cause| error(&selected, cause))?)));
            } else { return Err("目录树端口不指向文件或文件夹。".into()); }
            self.scans.insert(selected.clone(), files);
        }
        let selection_parent = selected.strip_prefix(&base).ok()
            .and_then(Path::parent).unwrap_or_else(|| Path::new(""));
        self.scans[&selected].iter().map(|(path, bytes, modified)| {
            let relative = path.strip_prefix(&base).map_err(|cause| cause.to_string())?.to_path_buf();
            Ok(Item { path: path.clone(), root: selected.clone(), output: relative.clone(), relative,
                selection_parent: selection_parent.to_path_buf(),
                bytes: *bytes, modified: *modified, camera: None, filtered: false })
        }).collect()
    }

    fn evaluate(&mut self, node: &'a Node, output: &str) -> Result<Vec<Item>, String> {
        if node.kind == Kind::Source { return self.source(&node.value, output); }
        if node.kind == Kind::Tree {
            let folder = self.inputs.get(node.id.as_str()).and_then(|edges| edges.first())
                .map(|edge| self.nodes[edge.source.as_str()].value.as_str())
                .unwrap_or(node.value.as_str());
            return self.source(folder, output);
        }
        if node.kind == Kind::Outputtree { return self.output_tree(node); }
        if node.kind == Kind::Merge {
            let incoming = self.inputs.get(node.id.as_str()).ok_or("「合并文件」需要连接至少一个输入。")?;
            let mut seen: HashMap<(String, String), usize> = HashMap::new();
            let mut result: Vec<Item> = Vec::new();
            for edge in incoming {
                for file in self.read_edge(edge)?.iter() {
                    let identity = (key(&file.path), key(&file.output));
                    if let Some(&index) = seen.get(&identity) {
                        result[index].camera = result[index].camera.or(file.camera);
                        result[index].filtered |= file.filtered;
                    } else {
                        seen.insert(identity, result.len());
                        result.push(file.clone());
                        if result.len() > 40_000 { return Err("合并后的清单超过 40,000 项。".into()); }
                    }
                }
            }
            return Ok(result);
        }
        let list = self.input(&node.id, "files")?.ok_or("文件清单节点缺少主输入。")?;
        match node.kind {
            Kind::Subtract => {
                let exclusions = self.input(&node.id, "exclude")?.ok_or("「排除文件」需要连接「排除文件」端口。")?;
                let paths: HashSet<_> = exclusions.iter().map(|item| key(&item.path)).collect();
                self.filter(&list, |item| !paths.contains(&key(&item.path)))
            }
            Kind::Filter => {
                let (exclude, text) = node.value.strip_prefix("exclude:").map_or((false, node.value.as_str()), |text| (true, text));
                let extensions: HashSet<_> = text.split(',').map(|ext| ext.trim().trim_start_matches('.').to_ascii_lowercase())
                    .filter(|ext| !ext.is_empty()).collect();
                if extensions.is_empty() { return Ok(list.as_ref().clone()); }
                self.filter(&list, |item| {
                    let extension = item.path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
                    extensions.contains(&extension) != exclude
                })
            }
            Kind::Directory => {
                let prefix: PathBuf = node.value.split('/').map(|part| self.folder_name(part))
                    .collect::<Result<Vec<_>, _>>()?.iter().collect();
                Ok(list.iter().cloned().map(|mut item| { item.output = prefix.join(item.output); item }).collect())
            }
            Kind::Camera => {
                if list.iter().any(|item| item.filtered) {
                    return Err("相机模式暂不支持清单排除，以保留素材关联。".into());
                }
                let selected = sony::Category::from_handle(output);
                if selected.is_some() {
                    self.sony_split_sources.extend(list.iter().map(|item| item.path.clone()));
                }
                Ok(list.iter().zip(sony::classify(&list)?).filter_map(|(item, category)| {
                    if selected.is_some_and(|selected| selected != category) { return None; }
                    let mut item = item.clone();
                    item.camera = Some(category);
                    Some(item)
                }).collect())
            }
            _ => Err("无效的文件清单节点。".into()),
        }
    }

    fn output_tree(&mut self, node: &'a Node) -> Result<Vec<Item>, String> {
        let entries: Vec<OutputFolder> = if node.value.is_empty() { Vec::new() }
            else { serde_json::from_str(&node.value).map_err(|_| "目标目录树配置无效。")? };
        if entries.len() > 100 { return Err("目标目录树最多支持 100 个子目录。".into()); }
        let mut folders: HashMap<String, PathBuf> = HashMap::new();
        let mut paths = HashSet::new();
        for entry in entries {
            if entry.id.is_empty() || folders.contains_key(&entry.id) {
                return Err("目标目录树含无效或重复的文件夹编号。".into());
            }
            let parent = match entry.parent {
                Some(id) => folders.get(&id).ok_or("目标目录树的上级文件夹不存在。")?.clone(),
                None => PathBuf::new(),
            };
            let path = parent.join(self.folder_name(&entry.name)?);
            if !paths.insert(key(&path)) {
                return Err(format!("目标目录树含重复目录：{}", path.display()));
            }
            folders.insert(entry.id, path);
        }
        let incoming = self.inputs.get(node.id.as_str()).ok_or("目标目录树至少需要连接一条文件清单。")?;
        let mut result = Vec::new();
        for edge in incoming {
            let handle = edge.target_handle.as_deref().unwrap_or("files");
            let disk = handle.strip_prefix("disk:").map(disk_folder).transpose()?;
            let prefix = if let Some(id) = handle.strip_prefix("folder:") {
                Some(folders.get(id).ok_or("目标目录树连线指向不存在的文件夹。")?)
            } else { disk.as_ref() };
            let files = self.read_edge(edge)?;
            if result.len() + files.len() > 40_000 { return Err("目标目录树的清单超过 40,000 项。".into()); }
            result.extend(files.iter().cloned().map(|mut item| {
                if let Some(prefix) = prefix {
                    let relative = if disk.is_some() && item.output == item.relative {
                        item.output.strip_prefix(&item.selection_parent).unwrap_or(&item.output)
                    } else { &item.output };
                    item.output = prefix.join(relative);
                }
                item
            }));
        }
        Ok(result)
    }

    fn filter(&mut self, list: &[Item], keep: impl Fn(&Item) -> bool) -> Result<Vec<Item>, String> {
        if list.iter().any(|item| item.camera.is_some()) { return Err("相机模式暂不支持清单排除，以保留素材关联。".into()); }
        Ok(list.iter().filter_map(|item| {
            if keep(item) {
                let mut item = item.clone();
                item.filtered = true;
                Some(item)
            } else {
                self.excluded.insert(item.path.clone());
                None
            }
        }).collect())
    }
}
