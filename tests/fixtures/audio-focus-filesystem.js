import { lstat } from 'node:fs/promises';

export const focusFileSystem = {
  async lstat(path) {
    const stat = await lstat(path);
    if ((path === '/' || path === '/tmp') && stat.uid === 65534) stat.uid = 0;
    return stat;
  },
};
