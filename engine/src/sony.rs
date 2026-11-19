use std::{collections::HashSet, fs, io::Read, path::Path};

use crate::file_lists::Item;

pub(crate) const UNRECOGNIZED: &str =
    "未识别到 Sony 相机结构。请选择完整的相机卡目录，通用文件可绕过「Sony 素材分类」。";

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Category {
    Photo,
    Video,
    Proxy,
    Management,
    Lut,
    Other,
}

impl Category {
    pub(crate) fn from_handle(handle: &str) -> Option<Self> {
        Some(match handle {
            "sony:photos" => Self::Photo,
            "sony:videos" => Self::Video,
            "sony:proxies" => Self::Proxy,
            "sony:management" => Self::Management,
            "sony:luts" => Self::Lut,
            "sony:other" => Self::Other,
            _ => return None,
        })
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Photo => "照片",
            Self::Video => "视频",
            Self::Proxy => "代理",
            Self::Management => "卡管理文件",
            Self::Lut => "LUT 文件",
            Self::Other => "其他文件",
        }
    }
}

#[derive(Hash, PartialEq, Eq)]
struct Clip<'a> {
    media_root: &'a Path,
    stem: String,
    category: Category,
}

enum File<'a> {
    Plain(Category),
    Clip(Clip<'a>),
    Sidecar(Clip<'a>),
}

pub(crate) fn classify(items: &[Item]) -> Result<Vec<Category>, String> {
    let files: Vec<_> = items.iter().map(inspect).collect();
    let clips: HashSet<_> = files.iter().filter_map(|file| match file {
        File::Clip(clip) => Some(clip),
        _ => None,
    }).collect();
    let mut roots = HashSet::new();
    let mut recognized = HashSet::new();
    let mut layouts = HashSet::new();
    for (item, file) in items.iter().zip(&files) {
        let root = item.path.ancestors().nth(item.relative.components().count())
            .ok_or("无法确定 Sony 素材的来源目录。")?;
        roots.insert(root);
        if matches!(file, File::Clip(_) | File::Plain(Category::Photo | Category::Video)) {
            layouts.insert(root);
        }
        if !recognized.contains(root) && matches!(file, File::Sidecar(clip) if clips.contains(clip))
            && item.path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
            && sony_clip_metadata(&item.path)
        {
            recognized.insert(root);
        }
    }
    for root in layouts {
        if !recognized.contains(root) && sony_card_marker(root) { recognized.insert(root); }
    }
    if roots.is_empty() || roots != recognized {
        return Err(UNRECOGNIZED.into());
    }
    Ok(files.iter().map(|file| match file {
        File::Plain(category) => *category,
        File::Clip(clip) => clip.category,
        File::Sidecar(clip) if clips.contains(clip) => clip.category,
        File::Sidecar(_) => Category::Management,
    }).collect())
}

fn sony_card_marker(root: &Path) -> bool {
    let mut path = root.to_path_buf();
    for (index, component) in ["PRIVATE", "SONY", "SONYCARD.IND"].into_iter().enumerate() {
        path.push(component);
        let Ok(info) = fs::symlink_metadata(&path) else { return false; };
        let expected_type = if index == 2 { info.is_file() } else { info.is_dir() };
        if crate::is_link(&info) || !expected_type { return false; }
    }
    true
}

fn sony_clip_metadata(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else { return false; };
    let mut xml = String::new();
    if file.take(256 * 1024).read_to_string(&mut xml).is_err() || !xml.contains("<NonRealTimeMeta") { return false; }
    xml.split("<Device").skip(1).filter_map(|tail| tail.split('>').next()).any(|tag| {
        tag.starts_with(char::is_whitespace) && tag.split_whitespace().any(|attribute|
            matches!(attribute.trim_end_matches('/'), "manufacturer=\"Sony\"" | "manufacturer='Sony'"))
    })
}

fn inspect(item: &Item) -> File<'_> {
    use Category::*;
    let parts: Vec<_> = item.relative.iter().map(|part| part.to_string_lossy().to_ascii_uppercase()).collect();
    let parts: Vec<_> = parts.iter().map(String::as_str).collect();
    let name = item.relative.file_name().unwrap_or_default().to_string_lossy();
    let extension = item.relative.extension().unwrap_or_default().to_string_lossy().to_ascii_uppercase();
    let stem = item.relative.file_stem().unwrap_or_default().to_string_lossy().to_ascii_uppercase();
    if name.starts_with("._") { return File::Plain(Other); }

    let media = parts.strip_prefix(&["PRIVATE"]).unwrap_or(&parts);
    let kind = match media {
        ["M4ROOT", "CLIP" | "SUB" | "THMBNL", ..] => {
            xavc(media, &item.path, &extension, &stem)
        }
        ["DCIM", _, _, ..] if matches!(extension.as_str(), "ARW" | "JPG" | "JPEG" | "HIF" | "HEIF") => Some(File::Plain(Photo)),
        ["AVCHD", "BDMV", "STREAM", _] if matches!(extension.as_str(), "MTS" | "M2TS") => Some(File::Plain(Video)),
        ["SONY", "PRO", "LUT", _] if extension == "CUBE" => Some(File::Plain(Lut)),
        ["M4ROOT", "MEDIAPRO.XML"] | ["AVCHD", "BDMV", ..] | ["DATABASE", ..] | ["SONY", "SONYCARD.IND"] =>
            Some(File::Plain(Management)),
        _ => None,
    };
    kind.unwrap_or(File::Plain(Other))
}

fn xavc<'a>(parts: &[&str], path: &'a Path, extension: &str, stem: &str) -> Option<File<'a>> {
    let [_, folder, _] = parts else { return None; };
    let media_root = path.parent()?.parent()?;
    let category = if *folder == "SUB" { Category::Proxy } else { Category::Video };
    let clip = |stem: &str| Clip { media_root, stem: stem.into(), category };
    match (*folder, extension) {
        ("CLIP", "MP4" | "MXF") | ("SUB", "MP4") => Some(File::Clip(clip(stem))),
        ("CLIP" | "SUB", "XML") => Some(stem.strip_suffix("M01")
            .map_or(File::Plain(Category::Management), |stem| File::Sidecar(clip(stem)))),
        ("THMBNL", "JPG" | "JPEG") => Some(stem.strip_suffix("T01")
            .map_or(File::Plain(Category::Management), |stem| File::Sidecar(clip(stem)))),
        _ => None,
    }
}
