cd "$(dirname "$0")"
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('.raytace/raytace.db');
console.log(db.prepare('PRAGMA user_version').get());
console.log(db.prepare('PRAGMA table_info(tool_executions)').all().map(c => c.name));
"
