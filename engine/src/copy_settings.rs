use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MIB: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode { Auto, Parallel, Batch }

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct CopySettings {
    pub buffer_mib: usize,
    pub block_mib: usize,
    pub queue_depth: usize,
    pub small_file_kib: u64,
    pub mode: Mode,
    pub limit_mib_s: u32,
    pub low_io: bool,
}

impl Default for CopySettings {
    fn default() -> Self {
        Self { buffer_mib: 32, block_mib: 2, queue_depth: 8, small_file_kib: 128,
            mode: Mode::Auto, limit_mib_s: 0, low_io: false }
    }
}

impl CopySettings {
    pub fn parse(value: &str) -> Result<Self, String> {
        let settings = match value.trim() {
            "" => Self::default(),
            value if value.starts_with('{') => serde_json::from_str(value)
                .map_err(|cause| format!("流复制策略参数无效：{cause}"))?,
            value => {
                let block_mib = value.parse::<usize>().map_err(|_| "流复制策略的块大小无效。")?;
                if !matches!(block_mib, 1 | 2 | 4 | 8) { return Err("旧版快速流块大小无效。".into()); }
                Self { buffer_mib: block_mib * 3, block_mib, queue_depth: 3, small_file_kib: (block_mib * 2048) as u64,
                    mode: Mode::Parallel, ..Self::default() }
            }
        };
        for (label, value, min, max, unit) in [
            ("I/O 块大小", settings.block_mib as u64, 1, 32, " MiB"),
            ("在途缓冲块", settings.queue_depth as u64, 1, 32, " 个"),
            ("小文件阈值", settings.small_file_kib, 0, 65_536, " KiB"),
            ("限速", u64::from(settings.limit_mib_s), 0, 10_000, " MiB/s"),
        ] {
            if !(min..=max).contains(&value) {
                return Err(format!("{label}必须在 {min}–{max}{unit} 之间，当前为 {value}{unit}。"));
            }
        }
        if settings.buffer_mib > isize::MAX as usize / MIB {
            return Err("主缓冲区超出当前平台可表示的内存大小。".into());
        }
        if settings.buffer_mib < settings.block_mib {
            return Err(format!("主缓冲区至少需要 {} MiB，才能容纳一个 I/O 块。", settings.block_mib));
        }
        Ok(settings)
    }

    pub fn effective_mode(self, source: &Path, target: &Path) -> Mode {
        if self.mode != Mode::Auto { return self.mode; }
        #[cfg(windows)]
        {
            if let Some(mode) = windows::choose(source, target) { return mode; }
        }
        let _ = (source, target);
        Mode::Parallel
    }

    pub fn slots(self) -> usize { self.queue_depth.min(self.buffer_mib / self.block_mib) }
}

pub struct IoPriorityGuard(#[cfg(windows)] bool);

impl IoPriorityGuard {
    pub fn enter(enabled: bool) -> Self {
        #[cfg(windows)]
        {
            Self(enabled && windows::background_thread(true))
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Self()
        }
    }
}

#[cfg(windows)]
impl Drop for IoPriorityGuard {
    fn drop(&mut self) {
        if self.0 { windows::background_thread(false); }
    }
}

#[cfg(windows)]
mod windows {
    use super::{Mode, Path};
    use std::{ffi::c_void, fs::{File, OpenOptions}, mem::size_of,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle}, path::{Component, Prefix},
        ptr::{null, null_mut}};

    const VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;
    const STORAGE_QUERY_PROPERTY: u32 = 0x002d_1400;
    const STORAGE_DEVICE_SEEK_PENALTY: u32 = 7;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> *mut c_void;
        fn SetThreadPriority(thread: *mut c_void, priority: i32) -> i32;
        fn DeviceIoControl(handle: *mut c_void, code: u32, input: *const c_void,
            input_size: u32, output: *mut c_void, output_size: u32,
            returned: *mut u32, overlapped: *mut c_void) -> i32;
    }

    pub fn background_thread(begin: bool) -> bool {
        // Background mode adjusts scheduling priority, including disk I/O, for the calling thread.
        let priority = if begin { 0x0001_0000 } else { 0x0002_0000 };
        unsafe { SetThreadPriority(GetCurrentThread(), priority) != 0 }
    }

    #[repr(C)]
    struct DiskExtent { disk: u32, start: i64, length: i64 }
    #[repr(C)]
    struct Extents { count: u32, entries: [DiskExtent; 32] }
    #[repr(C)]
    struct SeekPenalty { version: u32, size: u32, incurs: u8 }

    fn query<T>(file: &File, code: u32, input: &[u32], output: &mut T) -> Option<usize> {
        let mut returned = 0;
        // The handle is synchronous and the buffers remain valid for the duration of the call.
        let status = unsafe {
            DeviceIoControl(file.as_raw_handle(), code,
                if input.is_empty() { null() } else { input.as_ptr().cast() },
                std::mem::size_of_val(input) as u32, (output as *mut T).cast(),
                size_of::<T>() as u32, &mut returned, null_mut())
        };
        (status != 0 && returned as usize <= size_of::<T>()).then_some(returned as usize)
    }

    fn letter(path: &Path) -> Option<u8> {
        let Component::Prefix(prefix) = path.components().next()? else { return None; };
        match prefix.kind() {
            Prefix::VerbatimDisk(letter) | Prefix::Disk(letter) => Some(letter.to_ascii_uppercase()),
            _ => None,
        }
    }

    fn open_volume(letter: u8) -> Option<File> {
        OpenOptions::new().access_mode(0).open(format!(r"\\.\{}:", char::from(letter))).ok()
    }

    fn disks(file: &File) -> Option<Vec<u32>> {
        let mut extents: Extents = unsafe { std::mem::zeroed() };
        let returned = query(file, VOLUME_DISK_EXTENTS, &[], &mut extents)?;
        let count = extents.count as usize;
        if count == 0 || count > extents.entries.len()
            || returned < std::mem::offset_of!(Extents, entries) + count * size_of::<DiskExtent>() {
            return None;
        }
        Some(extents.entries[..count].iter().map(|entry| entry.disk).collect())
    }

    fn seek_penalty(file: &File) -> Option<bool> {
        let mut penalty = SeekPenalty { version: 0, size: 0, incurs: 0 };
        let bytes = query(file, STORAGE_QUERY_PROPERTY, &[STORAGE_DEVICE_SEEK_PENALTY, 0, 0], &mut penalty)?;
        (bytes >= 9 && penalty.size >= 9).then_some(penalty.incurs != 0)
    }

    pub fn choose(source: &Path, target: &Path) -> Option<Mode> {
        let source = letter(source)?;
        let target = letter(target)?;
        let source_volume = open_volume(source);
        if source == target {
            return Some(if source_volume.as_ref().and_then(seek_penalty) == Some(false) {
                Mode::Parallel
            } else { Mode::Batch });
        }
        let source_volume = source_volume?;
        let target_volume = open_volume(target)?;
        let target_disks = disks(&target_volume)?;
        let shared = disks(&source_volume)?.iter().any(|disk| target_disks.contains(disk));
        if !shared || (seek_penalty(&source_volume) == Some(false) && seek_penalty(&target_volume) == Some(false)) {
            Some(Mode::Parallel)
        } else {
            Some(Mode::Batch)
        }
    }
}
