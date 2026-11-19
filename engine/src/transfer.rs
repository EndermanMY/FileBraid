use super::{error, is_link, root, target_path, Plan, Row, VerifyTiming};
use serde::Serialize;
use crate::checksum::{Algorithm, Checksums, Hasher};
use crate::copy_settings::{CopySettings, IoPriorityGuard, Mode, MIB};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::{mpsc, Condvar, Mutex},
    time::{Duration, Instant},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct Outcome {
    destination: PathBuf,
    target: String,
    source: PathBuf,
    status: &'static str,
    checksums: Checksums,
    source_checksums: Checksums,
    target_checksums: Checksums,
    retried: bool,
    error: Option<String>,
}

fn source_matches(row: &Row) -> Result<(), String> {
    let metadata = fs::symlink_metadata(&row.source).map_err(|cause| error(&row.source, cause))?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() != row.bytes
        || metadata.modified().ok() != Some(row.modified.0)
    {
        return Err(format!("来源已变化：{}", row.source.display()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Progress<'a> {
    kind: &'static str,
    destination: &'a Path,
    target: &'a str,
    phase: &'static str,
    bytes: u64,
    bytes_per_second: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_checksums: Option<&'a Checksums>,
}

type Hashers = Vec<(Algorithm, Hasher)>;

fn update_hashes(hashes: &mut Hashers, bytes: &[u8]) {
    for (_, hash) in hashes { hash.update(bytes); }
}

#[derive(Default)]
struct ControlState {
    cancelled: bool,
    paused_at: Option<Instant>,
    pause_time: Duration,
}

#[derive(Default)]
pub struct TransferControl {
    state: Mutex<ControlState>,
    changed: Condvar,
}

impl TransferControl {
    pub fn pause(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.cancelled && state.paused_at.is_none() {
            state.paused_at = Some(Instant::now());
        }
    }

    pub fn resume(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(start) = state.paused_at.take() {
            state.pause_time += start.elapsed();
        }
        self.changed.notify_all();
    }

    pub fn cancel(&self) {
        self.state.lock().unwrap().cancelled = true;
        self.changed.notify_all();
    }

    fn is_cancelled(&self) -> bool {
        self.state.lock().unwrap().cancelled
    }

    fn paused_for(&self) -> Duration {
        let state = self.state.lock().unwrap();
        state.pause_time + state.paused_at.map_or(Duration::ZERO, |start| start.elapsed())
    }
}

fn check_stop(stopped: &TransferControl) -> Result<(), String> {
    let state = stopped.changed.wait_while(stopped.state.lock().unwrap(), |state|
        state.paused_at.is_some() && !state.cancelled).unwrap();
    if state.cancelled { Err("任务已中止。".into()) } else { Ok(()) }
}

fn prepare_buffer(buffer: &mut Vec<u8>, size: usize) -> Result<(), String> {
    if buffer.len() < size {
        buffer.try_reserve_exact(size - buffer.len())
            .map_err(|_| format!("无法申请 {} MiB 复制缓冲区，请减小主缓冲区或在途缓冲数。", size.div_ceil(MIB)))?;
        buffer.resize(size, 0);
    }
    Ok(())
}

fn pump(path: &Path, mut output: Option<&mut File>, algorithms: &[Algorithm],
    stopped: &TransferControl, options: Option<(CopySettings, Mode)>, scratch: &mut Vec<u8>,
    mut advance: impl FnMut(usize) -> Result<(), String>,
) -> Result<Checksums, String> {
    let mut input = File::open(path).map_err(|cause| error(path, cause))?;
    let mut hashes: Hashers = algorithms.iter().map(|&algorithm| (algorithm, Hasher::new(algorithm))).collect();
    let file_size = input.metadata().map_err(|cause| error(path, cause))?.len();
    let large = options.filter(|(settings, _)| {
        file_size > settings.small_file_kib * 1024 && file_size > settings.block_mib as u64 * MIB as u64
    });
    if let (Some((settings, Mode::Parallel)), Some(writer)) = (large, output.as_mut()) {
        let slots = settings.slots();
        if slots > 1 {
            *scratch = Vec::new();
            pipeline(&mut input, writer, path, settings, &mut hashes, stopped, advance)?;
            return Ok(hashes.into_iter().map(|(algorithm, hash)| (algorithm, hash.finish())).collect());
        }
    }
    let block = options.map_or(MIB, |(settings, _)| settings.block_mib * MIB);
    let limit = match (large, output.is_some()) {
        (Some((settings, Mode::Batch)), true) => settings.buffer_mib * MIB,
        _ => block,
    };
    let size = file_size.clamp(1, limit as u64) as usize;
    prepare_buffer(scratch, size)?;
    let buffer = &mut scratch[..size];
    loop {
        check_stop(stopped)?;
        let mut bytes = 0;
        while bytes < size {
            check_stop(stopped)?;
            let read = input.read(&mut buffer[bytes..(bytes + block).min(size)]).map_err(|cause| error(path, cause))?;
            if read == 0 { break; }
            bytes += read;
        }
        if bytes == 0 { break; }
        update_hashes(&mut hashes, &buffer[..bytes]);
        for chunk in buffer[..bytes].chunks(block) {
            check_stop(stopped)?;
            if let Some(file) = &mut output {
                file.write_all(chunk).map_err(|cause| cause.to_string())?;
            }
            advance(chunk.len())?;
        }
    }
    Ok(hashes.into_iter().map(|(algorithm, hash)| (algorithm, hash.finish())).collect())
}

fn pipeline(input: &mut File, writer: &mut File, path: &Path, settings: CopySettings,
    hashes: &mut Hashers, stopped: &TransferControl, mut advance: impl FnMut(usize) -> Result<(), String>,
) -> Result<(), String> {
    let slots = settings.slots();
    let block = settings.block_mib * MIB;
    let mut pool = Vec::with_capacity(slots);
    for _ in 0..slots {
        check_stop(stopped)?;
        let mut buffer = Vec::new();
        prepare_buffer(&mut buffer, block)?;
        pool.push(buffer);
    }
    std::thread::scope(|scope| {
        let (free, buffers) = mpsc::channel();
        let (ready, chunks) = mpsc::sync_channel::<(Vec<u8>, usize)>(slots - 1);
        for buffer in pool { free.send(buffer).expect("buffer receiver is open"); }
        let reader = scope.spawn(move || {
            let _priority = IoPriorityGuard::enter(settings.low_io);
            while let Ok(mut buffer) = buffers.recv() {
                check_stop(stopped)?;
                let size = input.read(&mut buffer).map_err(|cause| error(path, cause))?;
                if size == 0 { break; }
                update_hashes(hashes, &buffer[..size]);
                if ready.send((buffer, size)).is_err() { break; }
            }
            Ok::<(), String>(())
        });
        let written = (|| {
            for (buffer, size) in &chunks {
                check_stop(stopped)?;
                writer.write_all(&buffer[..size]).map_err(|cause| cause.to_string())?;
                advance(size)?;
                let _ = free.send(buffer);
            }
            Ok::<(), String>(())
        })();
        drop(chunks);
        drop(free);
        let read = reader.join().expect("copy reader panicked");
        written.and(read)
    })
}

fn transfer_stream(row: &Row, path: &Path, output: Option<&mut File>, algorithms: &[Algorithm],
    stopped: &TransferControl, scratch: &mut Vec<u8>, phase: &'static str, report: &impl Fn(&Progress),
) -> Result<Checksums, String> {
    let mut bytes = 0;
    let mut tick = Instant::now();
    let mut previous = 0;
    let emit = |bytes, bytes_per_second| report(&Progress {
        kind: "progress", destination: &row.destination, target: &row.target, phase, bytes, bytes_per_second,
        source_checksums: None,
    });
    emit(0, 0.0);
    let timed_from = Instant::now();
    let paused_before = stopped.paused_for();
    let mut paused_at_tick = paused_before;
    let options = row.copy_settings.zip(row.copy_mode);
    let limit = if phase == "copy" { options.map_or(0, |(settings, _)| settings.limit_mib_s) } else { 0 };
    let checksums = pump(path, output, algorithms, stopped, options, scratch, |chunk| {
        bytes += chunk as u64;
        if limit != 0 {
            let ideal = Duration::from_secs_f64(bytes as f64 / (f64::from(limit) * MIB as f64));
            loop {
                check_stop(stopped)?;
                let paused = stopped.paused_for().saturating_sub(paused_before);
                let active = timed_from.elapsed().saturating_sub(paused);
                let Some(wait) = ideal.checked_sub(active) else { break; };
                if wait.is_zero() { break; }
                std::thread::sleep(wait.min(Duration::from_millis(25)));
            }
        }
        let paused = stopped.paused_for();
        let elapsed = tick.elapsed().saturating_sub(paused.saturating_sub(paused_at_tick));
        if elapsed >= Duration::from_millis(225) {
            emit(bytes, (bytes - previous) as f64 / elapsed.as_secs_f64());
            tick = Instant::now();
            paused_at_tick = paused;
            previous = bytes;
        }
        Ok(())
    })?;
    let elapsed = tick.elapsed().saturating_sub(stopped.paused_for().saturating_sub(paused_at_tick));
    emit(bytes, if bytes > previous { (bytes - previous) as f64 / elapsed.as_secs_f64().max(0.001) } else { 0.0 });
    Ok(checksums)
}

#[cfg(windows)]
fn publish(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
    }
    let wide = |path: &Path| path.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let from = wide(temporary);
    let to = wide(destination);
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::hard_link(temporary, destination)
}

struct Temporary(PathBuf);

impl Drop for Temporary {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

fn temporary(parent: &Path) -> io::Result<(Temporary, File)> {
    loop {
        let serial = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".filebraid-{}-{serial}.partial", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((Temporary(path), file)),
            Err(cause) if cause.kind() == io::ErrorKind::AlreadyExists => {}
            Err(cause) => return Err(cause),
        }
    }
}

fn checked_target(row: &Row) -> Result<(&Path, bool), String> {
    let relative = row.destination.strip_prefix(&row.root).map_err(|cause| cause.to_string())?;
    if root(&row.root.to_string_lossy())? != row.root {
        return Err("目标路径已变化，请重新预览。".into());
    }
    let (_, exists) = target_path(&row.root, relative)?;
    Ok((relative, exists))
}

enum Prepared {
    Existing,
    Staged { temporary: Temporary, expected: Checksums },
}
type FileResult = Result<(&'static str, Checksums, bool), String>;

#[derive(Default)]
struct Comparison {
    source: Checksums,
    target: Checksums,
}

fn prepare(row: &Row, stopped: &TransferControl, verify_only: bool, scratch: &mut Vec<u8>, report: &impl Fn(&Progress)) -> Result<Prepared, String> {
    check_stop(stopped)?;
    let _priority = IoPriorityGuard::enter(row.copy_settings.is_some_and(|settings| settings.low_io));
    source_matches(row)?;
    let (relative, exists) = checked_target(row)?;
    if exists { return Ok(Prepared::Existing); }
    if verify_only { return Err("目标文件缺失。".into()); }
    let parent = row.destination.parent().ok_or("目标缺少上级目录。")?;
    fs::create_dir_all(parent).map_err(|cause| error(parent, cause))?;
    if target_path(&row.root, relative)?.1 { return Ok(Prepared::Existing); }
    let (temporary, mut output) = temporary(parent).map_err(|cause| error(parent, cause))?;
    let expected = transfer_stream(row, &row.source, Some(&mut output), &row.verified_by, stopped, scratch, "copy", report)?;
    check_stop(stopped)?;
    report(&Progress { kind: "progress", destination: &row.destination, target: &row.target,
        phase: "flush", bytes: row.bytes, bytes_per_second: 0.0, source_checksums: Some(&expected) });
    output.sync_all().map_err(|cause| cause.to_string())?;
    drop(output);
    source_matches(row)?;
    Ok(Prepared::Staged { temporary, expected })
}

fn finish(row: &Row, mut prepared: Prepared, stopped: &TransferControl, verify_only: bool,
    scratch: &mut Vec<u8>, report: &impl Fn(&Progress), comparison: &mut Comparison,
) -> FileResult {
    let _priority = IoPriorityGuard::enter(row.copy_settings.is_some_and(|settings| settings.low_io));
    for attempt in 0..2 {
        check_stop(stopped)?;
        source_matches(row)?;
        let (relative, exists) = checked_target(row)?;
        match prepared {
            Prepared::Existing => {
                if !exists { return Err("已有目标文件已移除，请重新加入队列。".into()); }
                let mut algorithms = row.verified_by.clone();
                if (algorithms.is_empty() || !verify_only) && !algorithms.contains(&Algorithm::Sha256) {
                    algorithms.push(Algorithm::Sha256);
                }
                comparison.source = transfer_stream(row, &row.source, None, &algorithms, stopped, scratch, "source", report)?;
                source_matches(row)?;
                comparison.target = transfer_stream(row, &row.destination, None, &algorithms, stopped, scratch, "verify", report)?;
                if comparison.target != comparison.source {
                    return Err(if verify_only { "目标文件校验值与来源不同。" } else { "已有目标文件内容不同，请调整目标路径。原文件已保留。" }.into());
                }
                source_matches(row)?;
                return Ok((if verify_only { "verified" } else { "reused" }, comparison.source.clone(), attempt != 0));
            }
            Prepared::Staged { temporary, expected } => {
                comparison.source.clone_from(&expected);
                if !row.verified_by.is_empty() {
                    comparison.target = transfer_stream(row, &temporary.0, None, &row.verified_by, stopped, scratch, "verify", report)?;
                    if comparison.target != comparison.source {
                        if attempt == 1 { return Err("目标校验值不匹配，完整重拷后仍失败。".into()); }
                        drop(temporary);
                        prepared = prepare(row, stopped, false, scratch, report)?;
                        comparison.target.clear();
                        continue;
                    }
                }
                source_matches(row)?;
                check_stop(stopped)?;
                target_path(&row.root, relative)?;
                publish(&temporary.0, &row.destination).map_err(|cause| error(&row.destination, cause))?;
                let status = if row.verified_by.is_empty() { "copied" } else { "verified" };
                return Ok((status, expected, attempt != 0));
            }
        }
    }
    unreachable!()
}

pub fn execute(plan: Plan, stopped: &TransferControl, verify_only: bool, report: impl Fn(&Outcome) + Sync,
    progress: impl Fn(&Progress) + Sync) -> Vec<Outcome> {
    let mut targets = BTreeMap::<String, Vec<Row>>::new();
    let source_changed = AtomicBool::new(false);
    for row in plan.rows {
        targets.entry(row.target.clone()).or_default().push(row);
    }
    std::thread::scope(|scope| {
        let report = &report;
        let progress = &progress;
        let source_changed = &source_changed;
        let workers: Vec<_> = targets.into_values().map(|rows| scope.spawn(move || {
            let mut scratch = Vec::new();
            let available = || {
                check_stop(stopped)?;
                if source_changed.load(Ordering::Relaxed) { return Err("来源已变化，任务已暂停。".into()); }
                Ok(())
            };
            let outcome = |row: Row, result: FileResult, comparison: Comparison| {
                if source_matches(&row).is_err() {
                    source_changed.store(true, Ordering::Relaxed);
                }
                let (status, checksums, retried, error) = match result {
                    Ok(_) if source_changed.load(Ordering::Relaxed) && source_matches(&row).is_err() =>
                        ("failed", Checksums::new(), false, Some("来源已变化，请重新预览。".into())),
                    Ok((status, checksums, retried)) => (status, checksums, retried, None),
                    Err(message) => (if stopped.is_cancelled() { "cancelled" } else { "failed" }, Checksums::new(), false, Some(message)),
                };
                let outcome = Outcome { destination: row.destination, target: row.target, source: row.source, status, checksums,
                    source_checksums: comparison.source, target_checksums: comparison.target, retried, error };
                report(&outcome);
                outcome
            };
            let mut outcomes = Vec::new();
            let mut pending = Vec::new();
            for row in rows {
                let prepared = available().and_then(|()| prepare(&row, stopped, verify_only, &mut scratch, progress));
                match prepared {
                    Ok(prepared) if !verify_only && row.verify_timing == Some(VerifyTiming::AfterCopy) => {
                        if let Prepared::Staged { expected, .. } = &prepared {
                            progress(&Progress {
                                kind: "progress", destination: &row.destination, target: &row.target,
                                phase: "await_verify", bytes: row.bytes, bytes_per_second: 0.0, source_checksums: Some(expected),
                            });
                        }
                        pending.push((row, prepared));
                    }
                    Ok(prepared) => {
                        let mut comparison = Comparison::default();
                        let result = available().and_then(|()| finish(&row, prepared, stopped, verify_only, &mut scratch, progress, &mut comparison));
                        outcomes.push(outcome(row, result, comparison));
                    }
                    Err(message) => outcomes.push(outcome(row, Err(message), Comparison::default())),
                }
            }
            for (row, prepared) in pending {
                let mut comparison = Comparison::default();
                let result = available().and_then(|()| finish(&row, prepared, stopped, false, &mut scratch, progress, &mut comparison));
                outcomes.push(outcome(row, result, comparison));
            }
            outcomes
        })).collect();
        workers.into_iter().flat_map(|worker| worker.join().expect("transfer worker panicked")).collect()
    })
}
