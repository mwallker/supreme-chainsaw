// Worker thread for tools/balance.mjs: plays campaigns with the knob values the main thread sends.
import { parentPort } from 'node:worker_threads';
import { runCampaign } from './balance.mjs';
import { LEVELS, SIZE_HP } from '../js/data/levels.js';

parentPort.on('message', ({ id, job, knobs, sizeHp }) => {
  for (const lv of LEVELS) for (const e of lv.encounters) if (knobs[e.id]) Object.assign(e, knobs[e.id]);
  sizeHp.forEach((v, i) => { SIZE_HP[i] = v; });
  parentPort.postMessage({ id, res: runCampaign(job) });
});
