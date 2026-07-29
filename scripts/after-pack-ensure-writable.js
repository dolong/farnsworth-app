// afterPack hook — guarantee every file in the packed bundle is owner-writable.
//
// Why this exists (Jul 29): macOS auto-update downloaded and staged fine, then
// ShipIt aborted the install with:
//   Installation error: ... Code=13 "Permission denied"
//   Couldn't remove quarantine attribute from ".../Contents/Resources/bin/nono".
//   This most likely means the file is read-only.
// Squirrel.Mac clears the com.apple.quarantine xattr from every file in the new
// bundle before swapping it in. removexattr(2) requires write permission on the
// file, so a single mode-555 file fails the ENTIRE update, permanently: ShipIt
// retries, hits "Too many attempts to install, aborting update", and the user
// silently stays on the old version forever.
//
// Resources/bin/nono shipped as r-xr-xr-x because that's how it was copied onto
// the build machine, and extraResources preserves file modes. It was the only
// non-writable file in the bundle. Rather than rely on the source file's mode
// (Resources/bin/ is gitignored, so the mode lives on one machine and nowhere
// else), enforce the invariant at pack time where it can be verified.
//
// Runs before signing, so it cannot invalidate the code signature.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const root = context.appOutDir;
  const fixed = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not this hook's problem; packaging will surface it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // mode of a symlink is meaningless on macOS
      if (entry.isDirectory()) {
        ensureWritable(full);
        walk(full);
      } else if (entry.isFile()) {
        ensureWritable(full);
      }
    }
  };

  const ensureWritable = (target) => {
    let st;
    try {
      st = fs.lstatSync(target);
    } catch {
      return;
    }
    // 0o200 = owner write. Anything missing it blocks Squirrel's xattr removal.
    if ((st.mode & 0o200) === 0) {
      fs.chmodSync(target, st.mode | 0o200);
      fixed.push({ path: path.relative(root, target), from: (st.mode & 0o777).toString(8) });
    }
  };

  walk(root);

  if (fixed.length === 0) {
    console.log('  • afterPack: all bundled files already owner-writable (auto-update safe)');
  } else {
    console.log(`  • afterPack: made ${fixed.length} file(s) owner-writable so Squirrel can clear quarantine on update:`);
    for (const f of fixed) console.log(`      ${f.from} -> +u+w  ${f.path}`);
  }
};
