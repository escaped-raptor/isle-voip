// Entry point for `npm start`. With no config.json it opens the first-run
// setup page; otherwise it starts the voice server.
import { run } from './launch.js';

run().catch((err) => {
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
});
