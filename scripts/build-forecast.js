// ESM wrapper — delegates to the CommonJS implementation
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('./build-forecast.cjs');
