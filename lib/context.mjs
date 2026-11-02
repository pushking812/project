// What the model knows about the project: ASK.md, Ask's memory of the folder, the folder's state.
import { basename } from 'node:path';
import { gatherNotes, readMemory, memoryDir, folderNow, NOTES_CHARS } from '../build/ask-code-core.mjs';

/**
 * @param {{root: string, site: string}} config
 * @returns {Promise<{folder: string, notes?: string, memory?: string, env: string, memoryDir: string}>}
 */
export async function buildContext(config) {
  const dir = memoryDir(config.site, config.root);
  const [{ text: notes }, memory, env] = await Promise.all([gatherNotes(config.root), readMemory(dir), folderNow(config.root)]);
  return {
    folder: basename(config.root),
    ...(notes ? { notes: notes.slice(0, NOTES_CHARS) } : {}),
    ...(memory !== undefined ? { memory } : {}),
    env,
    memoryDir: dir,
  };
}
