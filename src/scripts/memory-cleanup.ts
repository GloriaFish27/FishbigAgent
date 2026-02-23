/**
 * Memory Cleanup Script — archive expired memory entries
 *
 * Usage: npx ts-node --esm src/scripts/memory-cleanup.ts
 *   or:  npm run memory:cleanup
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryManager } from '../engine/memory-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

console.log('🧹 Memory Cleanup — FishbigAgent');
console.log(`   Data: ${DATA_DIR}`);
console.log('');

const manager = new MemoryManager(DATA_DIR);

// Run archive
const result = manager.archiveExpired();

console.log(`✅ Cleanup complete:`);
console.log(`   📦 Archived: ${result.archived} entries`);
console.log(`   📋 Remaining: ${result.remaining} active entries`);

// Show current P0 index
const entries = manager.loadP0();
if (entries.length > 0) {
    console.log('');
    console.log('📊 Active Memory Index:');
    for (const e of entries) {
        console.log(`   [${e.date}] [${e.priority}] ${e.p0.slice(0, 80)}`);
    }
}

console.log('');
console.log('Done 🐟');
