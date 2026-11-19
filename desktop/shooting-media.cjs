const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstat, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { promisify } = require('node:util');

const powershell = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$disks = @{}
Get-Disk | ForEach-Object { $disks[[int]$_.Number] = $_ }
$volumes = @{}
Get-Volume | Where-Object DriveLetter | ForEach-Object { $volumes[[string]$_.DriveLetter] = $_ }
$rows = @(Get-Partition | Where-Object DriveLetter | ForEach-Object {
  $disk = $disks[[int]$_.DiskNumber]
  $volume = $volumes[[string]$_.DriveLetter]
  if ($disk -and $volume -and $volume.FileSystem -and -not $disk.IsOffline) {
    [pscustomobject]@{
      letter = [string]$_.DriveLetter; bus = [string]$disk.BusType
      model = if ($disk.Model) { [string]$disk.Model } else { [string]$disk.FriendlyName }
      serial = [string]$disk.SerialNumber; diskId = [string]$disk.UniqueId
      volumeId = [string]$volume.UniqueId; size = [long]$volume.Size
      system = [bool]($disk.IsSystem -or $disk.IsBoot -or $_.IsSystem -or $_.IsBoot)
    }
  }
})
ConvertTo-Json -InputObject $rows -Compress
`;

async function hasShootingStructure(root) {
  try {
    const dcim = join(root, 'DCIM');
    if (!(await lstat(dcim)).isDirectory()) return false;
    for (const folder of await readdir(dcim, { withFileTypes: true })) {
      if (folder.isDirectory() && /^\d{3}[a-z\d_]{5}$/i.test(folder.name)) {
        const entries = await readdir(join(dcim, folder.name), { withFileTypes: true });
        if (entries.some(entry => entry.isFile() && !entry.name.startsWith('._') &&
          /\.(?:arw|jpg|jpeg|hif|heif|cr2|cr3|nef|raf|dng|rw2|mp4|mov)$/i.test(entry.name))) return true;
      }
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  try {
    const marker = await lstat(join(root, 'PRIVATE', 'SONY', 'SONYCARD.IND'));
    const clips = await lstat(join(root, 'PRIVATE', 'M4ROOT', 'CLIP'));
    return marker.isFile() && clips.isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

const text = value => typeof value === 'string' && value.trim() || null;

async function identifyMedia(rows, isShooting = hasShootingStructure) {
  const result = await Promise.all(rows.map(async disk => {
    if (disk.system || !/^[A-Z]$/i.test(disk.letter) || !(disk.size > 0)) return null;
    const deviceModel = text(disk.model);
    const deviceSerial = text(disk.serial);
    const volumeId = text(disk.volumeId);
    if (!volumeId) return null;
    const root = disk.letter.toUpperCase() + ':\\';
    const bus = String(disk.bus).toUpperCase();
    let type;
    if (bus === 'SD') type = 'sd';
    else if (/\bCFexpress\s*(?:Type\s*)?A\b/i.test(deviceModel ?? '')) type = 'cfa';
    else if (/\bCFexpress\s*(?:Type\s*)?B\b/i.test(deviceModel ?? '')) return null;
    else if (bus === 'USB' && await isShooting(root)) type = 'shooting-storage';
    else return null;

    const id = createHash('sha256').update(JSON.stringify([volumeId, text(disk.diskId), deviceSerial, disk.size])).digest('hex');
    const directMedia = type === 'sd' || (type === 'cfa' && bus === 'NVME');
    return {
      id, root, bus, type, deviceModel, deviceSerial,
      mediaModel: directMedia ? deviceModel : null,
      mediaSerial: directMedia ? deviceSerial : null,
    };
  }));
  return result.filter(Boolean).sort((a, b) => a.root.localeCompare(b.root));
}

let inflight;
let recent;
let scannedAt = 0;
async function listShootingMedia(fresh = false, useRecentSelection = false) {
  if (process.platform !== 'win32') return [];
  if (!fresh && recent && Date.now() - scannedAt < (useRecentSelection ? 10000 : 1500)) return recent;
  if (inflight) return inflight;
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  inflight = (async () => {
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-Command', powershell],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    recent = await identifyMedia(JSON.parse(stdout));
    scannedAt = Date.now();
    return recent;
  })();
  try { return await inflight; }
  finally { inflight = undefined; }
}

async function resolveMediaWorkflow(workflow, scan = () => listShootingMedia(true)) {
  if (!workflow.nodes.some(node => node.kind === 'media')) return { workflow, media: [] };
  const devices = await scan();
  const media = [];
  const nodes = workflow.nodes.map(node => {
    if (node.kind !== 'media') return node;
    let selection;
    try { selection = JSON.parse(node.value); } catch {}
    if (typeof selection?.id !== 'string' || typeof selection?.root !== 'string') {
      throw new Error('请先在「拍摄介质」节点选择来源设备。');
    }
    const device = devices.find(device => device.id === selection.id && device.root === selection.root);
    if (!device) throw new Error('拍摄介质已更换、移除或盘符变化，请重新选择来源。');
    media.push({ ...device, node: node.id });
    return { ...node, kind: 'source', value: device.root };
  });
  return { workflow: { ...workflow, nodes }, media };
}

module.exports = { identifyMedia, listShootingMedia, resolveMediaWorkflow };
