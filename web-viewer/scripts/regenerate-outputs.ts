/**
 * Script to regenerate output JSON files using band_layout.py, then run architect-agent for SVGs
 * Run with: npx tsx scripts/regenerate-outputs.ts
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { detectOverlaps } from './architect-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../..');
const DATA_DIR = path.join(__dirname, '../public/data');

const PROJECTS = ['p1', 'p4', 'p7', 'p9'];

async function regenerateAll() {
  console.log('============================================================');
  console.log('REGENERATE — band_layout.py → JSON → architect-agent SVGs');
  console.log('============================================================\n');

  // Step 1: Run Python band_layout to generate output JSONs
  console.log('Step 1: Running band_layout.py --json ...\n');
  const pythonCmd = path.join(ROOT, '.venv/bin/python');
  const scriptPath = path.join(ROOT, 'band_layout.py');
  try {
    const output = execSync(`${pythonCmd} ${scriptPath} --json`, {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
    });
    console.log(output);
  } catch (err: any) {
    console.error('Python band_layout.py failed:', err.message);
    if (err.stdout) console.log(err.stdout);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  // Step 2: Validate outputs and run overlap detection
  console.log('\nStep 2: Validating outputs...\n');
  for (const pid of PROJECTS) {
    const outputPath = path.join(DATA_DIR, `${pid}_output.json`);
    if (!fs.existsSync(outputPath)) {
      console.log(`  ⏭️  ${pid}: output not found`);
      continue;
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const resFloors = result.building.floors.filter(
      (f: any) => f.floor_type === 'RESIDENTIAL_TYPICAL'
    );
    const totalUnits = resFloors.reduce(
      (sum: number, f: any) => sum + f.spaces.filter((s: any) => s.type === 'DWELLING_UNIT').length, 0
    );
    console.log(`  ${pid.toUpperCase()}: ${result.building.floors.length} floors, ${totalUnits} total dwelling units`);

    let totalOverlaps = 0;
    for (const floor of result.building.floors) {
      const overlaps = detectOverlaps(floor);
      if (overlaps.length > 0) {
        totalOverlaps += overlaps.length;
        console.log(`    ⚠️  Floor ${floor.floor_index} (${floor.floor_type}): ${overlaps.length} overlap(s)`);
        for (const o of overlaps) {
          console.log(`       ${o.space1} ↔ ${o.space2}: ${o.overlap_area} SF`);
        }
      }
    }
    if (totalOverlaps === 0) {
      console.log(`    ✅ No overlaps`);
    }
  }

  console.log('\nDone! Output JSONs regenerated.');
}

regenerateAll().catch(console.error);
