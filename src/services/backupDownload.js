import { openSync, closeSync, fstatSync, constants, createReadStream } from 'node:fs';

export function openBackupDownload(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Backup ist keine regulaere eigenstaendige Datei.');
    return { size: stat.size, stream: createReadStream(path, { fd, autoClose: true }) };
  } catch (err) { closeSync(fd); throw err; }
}
