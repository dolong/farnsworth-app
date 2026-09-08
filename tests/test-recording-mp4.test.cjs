// Sep 8 2026: regression tests for WebM -> MP4 transcoding of test-run
// recordings. Long asked whether the recording feature could produce MP4
// instead of WebM.
//
// It can't at capture time: MediaRecorder in Electron 31 (Chromium 126) has no
// H.264 encoder or MP4 muxer, so the capture stays VP9/WebM and is transcoded
// once the file handle closes. The contract these tests pin down:
//   1. ffmpeg is OPTIONAL -- a missing binary keeps the .webm and reports the
//      reason, it never loses the recording.
//   2. the source .webm is only unlinked after a NON-EMPTY .mp4 exists.
//   3. the ffmpeg args stay QuickTime-safe (yuv420p, even dimensions,
//      faststart) because MediaRecorder emits odd-sized frames from the
//      390x844 mobile frame plus overlay.
//   4. the recordings list and the agent tool descriptions no longer assume
//      .webm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

// Extract the transcode block and run it against injected fs/child_process
// shims, so no ffmpeg binary is needed to test the failure paths.
function loadTranscoder({ ffmpegExists = true, execResult = null, statSize = 4096, env = {} } = {}) {
  const startAt = mainSrc.indexOf('const RECORDING_FFMPEG_CANDIDATES');
  assert.ok(startAt > -1, 'ffmpeg candidate list exists');
  const endAt = mainSrc.indexOf('async function stopCanvasTestRecording');
  assert.ok(endAt > startAt, 'transcode block located');
  const seg = mainSrc.slice(startAt, endAt);

  const calls = { exec: [], unlinked: [] };
  const fsSync = {
    constants: { X_OK: 1 },
    accessSync(p) { if (!ffmpegExists) throw new Error('ENOENT'); calls.probed = p; },
  };
  const fsp = {
    async stat() { return { size: statSize }; },
    async unlink(p) { calls.unlinked.push(p); },
  };
  const requireShim = (name) => {
    if (name !== 'child_process') throw new Error('unexpected require: ' + name);
    return {
      execFile(bin, args, opts, cb) {
        calls.exec.push({ bin, args, opts });
        const child = { on() { return child; } };
        setImmediate(() => cb(execResult));
        return child;
      },
    };
  };
  const factory = new Function(
    'fsSync', 'fs', 'require', 'process', 'console',
    `${seg}; return { transcodeRecordingToMp4, resolveFfmpegBin, recordingMp4Enabled };`,
  );
  const api = factory(fsSync, fsp, requireShim, { env }, { warn() {} });
  return { ...api, calls };
}

test('a successful transcode returns the .mp4 and removes the source .webm', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({});
  const src = '/p/.farnsworth/recordings/rail_2026-09-08T09-00-00.webm';
  const res = await transcodeRecordingToMp4(src);
  assert.equal(res.format, 'mp4');
  assert.equal(res.path, src.replace(/\.webm$/, '.mp4'));
  assert.equal(res.transcoded, true);
  assert.equal(res.bytes, 4096);
  assert.deepEqual(calls.unlinked, [src], 'the webm is dropped, the mp4 is kept');
});

test('a missing ffmpeg keeps the .webm instead of losing the recording', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({ ffmpegExists: false });
  const src = '/p/rec/a.webm';
  const res = await transcodeRecordingToMp4(src);
  assert.equal(res.path, src, 'reported path is still the real file');
  assert.equal(res.format, 'webm');
  assert.equal(res.transcodeError, 'ffmpeg_not_found');
  assert.equal(calls.exec.length, 0);
  assert.deepEqual(calls.unlinked, [], 'nothing is deleted when ffmpeg is absent');
});

test('an ffmpeg failure keeps the .webm and cleans up the partial .mp4', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({ execResult: new Error('exit 1') });
  const src = '/p/rec/b.webm';
  const res = await transcodeRecordingToMp4(src);
  assert.equal(res.path, src);
  assert.equal(res.format, 'webm');
  assert.match(res.transcodeError, /exit 1/);
  assert.deepEqual(calls.unlinked, ['/p/rec/b.mp4'], 'partial output removed, source untouched');
});

test('an empty .mp4 counts as a failure -- the source is never dropped', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({ statSize: 0 });
  const src = '/p/rec/c.webm';
  const res = await transcodeRecordingToMp4(src);
  assert.equal(res.path, src);
  assert.equal(res.transcodeError, 'empty_output');
  assert.deepEqual(calls.unlinked, ['/p/rec/c.mp4']);
});

test('FARNSWORTH_RECORD_FORMAT=webm opts out without invoking ffmpeg', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({ env: { FARNSWORTH_RECORD_FORMAT: 'webm' } });
  const res = await transcodeRecordingToMp4('/p/rec/d.webm');
  assert.equal(res.format, 'webm');
  assert.equal(res.path, '/p/rec/d.webm');
  assert.equal(calls.exec.length, 0);
});

test('a null or already-mp4 path is passed through untouched', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({});
  assert.equal((await transcodeRecordingToMp4(null)).path, null);
  assert.equal((await transcodeRecordingToMp4('/p/rec/e.mp4')).path, '/p/rec/e.mp4');
  assert.equal(calls.exec.length, 0);
});

test('FARNSWORTH_FFMPEG overrides the search path', () => {
  const { resolveFfmpegBin } = loadTranscoder({ env: { FARNSWORTH_FFMPEG: '/custom/ffmpeg' } });
  assert.equal(resolveFfmpegBin(), '/custom/ffmpeg');
});

test('the ffmpeg args stay QuickTime-safe', async () => {
  const { transcodeRecordingToMp4, calls } = loadTranscoder({});
  await transcodeRecordingToMp4('/p/rec/f.webm');
  const args = calls.exec[0].args.join(' ');
  // Odd-sized captures are real: the 390x844 mobile frame plus the step
  // overlay can hand MediaRecorder an odd height, and libx264 rejects it.
  assert.match(args, /scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);
  assert.match(args, /-c:v libx264/);
  assert.match(args, /-pix_fmt yuv420p/);      // QuickTime refuses 4:4:4
  assert.match(args, /-movflags \+faststart/); // scrubbable immediately
  assert.match(args, /-an/);                   // the capture has no audio
  assert.match(args, /-y /);                   // never block on an overwrite prompt
  assert.ok(calls.exec[0].opts.timeout > 0, 'a hung ffmpeg cannot wedge the run');
});

test('stopCanvasTestRecording reports the transcoded path and format', () => {
  const at = mainSrc.indexOf('async function stopCanvasTestRecording');
  const seg = mainSrc.slice(at, at + 2000);
  assert.match(seg, /await transcodeRecordingToMp4\(rec\.filePath\)/);
  assert.match(seg, /path: conv\.path/);
  assert.match(seg, /format: conv\.format/);
  // Duration must be measured before the transcode, which takes real seconds.
  assert.ok(
    seg.indexOf('const durationMs') < seg.indexOf('await transcodeRecordingToMp4'),
    'duration is captured before transcoding, not inflated by it',
  );
});

test('the recordings list surfaces mp4 files and tags the format', () => {
  const at = mainSrc.indexOf('async function listTestRecordings');
  const seg = mainSrc.slice(at, mainSrc.indexOf('async function openTestRecordingTarget'));
  assert.match(seg, /\/\\\.\(webm\|mp4\)\$\/i\.test\(entry\.name\)/, 'both extensions are listed');
  assert.match(seg, /format: \/\\\.mp4\$\/i\.test\(entry\.name\)/, 'entries carry a format');
  // The test name is derived by stripping the extension; a .mp4 must not keep
  // a dangling ".mp4" in its test label.
  assert.match(seg, /replace\(\/\\\.\(webm\|mp4\)\$\/i, ''\)/);
});

test('the agent-facing descriptions no longer promise a .webm', () => {
  const at = mainSrc.indexOf("name: 'test_recordings_list'");
  assert.ok(at > -1);
  const listDesc = mainSrc.slice(at, at + 600);
  assert.ok(!/the \.webm path/.test(listDesc), 'list tool does not claim a .webm path');
  assert.match(listDesc, /\.mp4/);
  assert.ok(
    !/a `video` object with the \.webm path/.test(mainSrc),
    'test_run no longer promises a .webm path',
  );
  assert.match(appSrc, /an \.mp4 \(H\.264/, 'system prompt describes the mp4 artifact');
});

// End-to-end, but only where ffmpeg actually exists. Skipped on machines
// without it rather than failing, because ffmpeg is an optional dependency.
const ffmpegBin = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  .find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

test('real ffmpeg produces a playable H.264 mp4 from an odd-sized VP9 capture', { skip: ffmpegBin ? false : 'ffmpeg not installed' }, () => {
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-rec-'));
  const webm = path.join(dir, 'cap.webm');
  const mp4 = path.join(dir, 'cap.mp4');
  try {
    // 391x845 mimics the odd-sized frame MediaRecorder can hand back.
    execFileSync(ffmpegBin, ['-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc=size=391x845:rate=30:duration=1',
      '-c:v', 'libvpx-vp9', '-b:v', '1M', '-pix_fmt', 'yuv420p', webm]);
    execFileSync(ffmpegBin, ['-y', '-loglevel', 'error', '-i', webm,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
    assert.ok(fs.statSync(mp4).size > 0, 'mp4 is non-empty');
    const probe = execFileSync(ffmpegBin.replace(/ffmpeg$/, 'ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0',
       '-show_entries', 'stream=codec_name,width,height,pix_fmt',
       '-of', 'default=nw=1', mp4]).toString();
    assert.match(probe, /codec_name=h264/);
    assert.match(probe, /width=390/, 'odd width rounded down to even');
    assert.match(probe, /height=844/, 'odd height rounded down to even');
    assert.match(probe, /pix_fmt=yuv420p/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
