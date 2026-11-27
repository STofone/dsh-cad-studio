/** Windows PATH/packager probe: why is a packager not found? */
import { __binSearch } from '../index.js'

const dirs = __binSearch.pathDirs()
const hits = dirs.filter((d) => /windowsapps|chocolatey|nodejs|freecad/i.test(d))
console.log(JSON.stringify({
  platform: process.platform,
  pathEntries: dirs.length,
  pathFirst: dirs.slice(0, 3),
  interesting: hits,
  winget: __binSearch.commandExists('winget'),
  choco: __binSearch.commandExists('choco'),
  packagers: __binSearch.PACKAGERS.filter((p) => !p.platform || p.platform === process.platform).map((p) => p.id),
  searchDirs: __binSearch.searchDirs(),
}, null, 2))
