/**
 * RedditAPIClientEmulator — Phase 1 (Tier 1 + Tier 2)
 *
 * In-memory stand-in for Devvit's RedditAPIClient. Same method signatures
 * as @devvit/public-api's RedditAPIClient class.
 *
 * Tier 1 (must-have):
 *   getCurrentUser, getCurrentUsername, getCurrentSubreddit,
 *   getCurrentSubredditName, getUserByUsername, getUserById, getAppUser,
 *   getSnoovatarUrl, getSubredditByName, getSubredditInfoByName,
 *   getSubredditById, getSubredditInfoById
 *
 * Tier 2 (Phase 1 scope, used by the-last-draft):
 *   getPostById, getPostsByUser, getCommentsByUser, getComments,
 *   submitCustomPost, submitPost, submitComment, setUserFlair,
 *   getTopPosts, getNewPosts, getHotPosts, getApprovedUsers,
 *   getBannedUsers, getModerators, getWikiPage, query (GraphQL stub)
 *
 * Tier 3 (Phase 2+, mod/mail/wiki/widget actions, vault, leaderboard):
 *   getModerationLog, getModNotes, addModNote, sendPrivateMessage,
 *   getWidgets, getWikiPages, getVaultByAddress, etc.
 *
 * Persistence: optional state file at `persistPath` that stores users,
 * subreddits, posts, comments, flairs across dev server restarts.
 * The user/subreddit library is seeded from JSON config (separate from
 * state) and re-merged on hydrate.
 */

function makeId(prefix, n) {
  return `${prefix}_${n.toString(36).padStart(6, '0')}`;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class RedditAPIClientEmulator {
  /**
   * @param {object} options
   * @param {string} options.currentUsername - active seeded user
   * @param {string} options.currentSubredditName - active subreddit
   * @param {string} options.persistPath - optional state file
   * @param {Array} options.seedUsers - initial user library
   * @param {Array} options.seedSubreddits - initial subreddit library
   */
  constructor(options = {}) {
    this._currentUsername = options.currentUsername || 'dev-user';
    this._currentSubredditName = options.currentSubredditName || 'dev-subreddit';
    this._persistPath = options.persistPath || null;

    this._users = new Map();        // username → User
    this._usersById = new Map();    // t2_* → User
    this._subreddits = new Map();   // name → Subreddit
    this._subredditsById = new Map(); // t5_* → Subreddit
    this._posts = new Map();        // t3_* → Post
    this._comments = new Map();     // t1_* → Comment
    this._flairs = new Map();       // `<subredditName>:<username>` → flair text
    this._counters = { post: 0, comment: 0, subreddit: 0, user: 0 };
    this._persistTimer = null;
    this._dirty = false;

    if (Array.isArray(options.seedUsers)) this._ingestUsers(options.seedUsers);
    if (Array.isArray(options.seedSubreddits)) this._ingestSubreddits(options.seedSubreddits);

    if (this._persistPath) {
      this._hydrate();
      this._hookExitFlush();
    }
  }

  // ----------------------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------------------

  _hydrate() {
    if (!this._persistPath) return;
    try {
      if (!existsSync(this._persistPath)) return;
      const raw = readFileSync(this._persistPath, 'utf8');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const r = parsed.reddit || {};
      if (Array.isArray(r.users)) this._ingestUsers(r.users);
      if (Array.isArray(r.subreddits)) this._ingestSubreddits(r.subreddits);
      if (Array.isArray(r.posts)) for (const p of r.posts) this._posts.set(p.id, p);
      if (Array.isArray(r.comments)) for (const c of r.comments) this._comments.set(c.id, c);
      if (Array.isArray(r.flairs)) for (const f of r.flairs) this._flairs.set(f.key, f.value);
      if (r.counters) Object.assign(this._counters, r.counters);
    } catch (e) {
      console.error('[reddit-emulator] hydrate failed:', e.message);
    }
  }

  _schedulePersist() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._flushNow(), 50);
  }

  // Only ever write a store we actually mutated. Two emulator instances can
  // hydrate the same state file in one Go Live (the NODE_OPTIONS loader hook
  // in the Vite process and the server-runner), and _hookExitFlush fires on
  // process exit unconditionally. Without this guard, an instance that never
  // touched Reddit would write its boot-time snapshot over posts and comments
  // the other instance had legitimately added.
  _flushNow() {
    if (!this._persistPath) return;
    if (!this._dirty) return;
    this._persistTimer = null;
    try {
      let file = {};
      if (existsSync(this._persistPath)) {
        try {
          file = JSON.parse(readFileSync(this._persistPath, 'utf8')) || {};
        } catch {}
      }
      file.reddit = {
        users: Array.from(this._users.values()),
        subreddits: Array.from(this._subreddits.values()),
        posts: Array.from(this._posts.values()),
        comments: Array.from(this._comments.values()),
        flairs: Array.from(this._flairs.entries()).map(([key, value]) => ({ key, value })),
        counters: this._counters,
      };
      mkdirSync(dirname(this._persistPath), { recursive: true });
      writeFileSync(this._persistPath, JSON.stringify(file, null, 2));
      this._dirty = false;
    } catch (e) {
      console.error('[reddit-emulator] persist failed:', e.message);
    }
  }

  _hookExitFlush() {
    const flush = () => {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      this._flushNow();
    };
    process.once('exit', flush);
  }

  // ----------------------------------------------------------------------
  // User / subreddit ingestion
  // ----------------------------------------------------------------------

  _ingestUsers(users) {
    for (const u of users) {
      const norm = {
        id: u.id,
        username: u.username,
        snoovatar: u.snoovatar ?? null,
        createdUtc: u.createdUtc ?? Math.floor(Date.now() / 1000),
        linkKarma: u.linkKarma ?? 0,
        commentKarma: u.commentKarma ?? 0,
        isEmployee: !!u.isEmployee,
      };
      this._users.set(norm.username, norm);
      this._usersById.set(norm.id, norm);
    }
  }

  _ingestSubreddits(subs) {
    for (const s of subs) {
      const norm = {
        id: s.id,
        name: s.name,
        type: s.type || 'public',
        memberCount: s.memberCount ?? 1,
      };
      this._subreddits.set(norm.name.toLowerCase(), norm);
      this._subredditsById.set(norm.id, norm);
    }
  }

  // ----------------------------------------------------------------------
  // Model wrappers — return objects matching the Devvit shape
  // ----------------------------------------------------------------------

  _wrapUser(u) {
    return {
      id: u.id,
      name: u.username,
      username: u.username,
      snoovatar: u.snoovatar,
      createdUtc: u.createdUtc,
      linkKarma: u.linkKarma,
      commentKarma: u.commentKarma,
      isEmployee: u.isEmployee,
    };
  }

  _wrapSubreddit(s) {
    return {
      id: s.id,
      name: s.name,
      displayName: s.name.replace(/^r\//, ''),
      title: s.name,
      publicDescription: '',
      type: s.type,
      memberCount: s.memberCount,
      url: `/r/${s.name.replace(/^r\//, '')}`,
      nsfw: false,
    };
  }

  _wrapPost(p) {
    return {
      id: p.id,
      name: p.name || p.id,
      authorName: p.authorName,
      subredditName: p.subredditName,
      title: p.title,
      url: p.url || `https://reddit.com${p.id.replace(/^t3_/, '/r/').replace('_', '/comments/')}`,
      permalink: p.permalink || `/r/${p.subredditName}/comments/${p.id}`,
      score: p.score ?? 1,
      thumbnail: p.thumbnail || 'self',
      createdUtc: p.createdUtc,
      body: p.body,
      kind: p.kind || 'self',
      isVideo: p.kind === 'video',
      isGallery: p.kind === 'gallery',
      isTextPost: !p.kind || p.kind === 'self' || p.kind === 'text',
      isLinkPost: p.kind === 'link',
    };
  }

  _wrapComment(c) {
    return {
      id: c.id,
      authorName: c.authorName,
      body: c.body,
      createdUtc: c.createdUtc,
      score: c.score ?? 1,
      parentId: c.parentId,
      linkId: c.linkId,
      subredditName: c.subredditName,
    };
  }

  // ----------------------------------------------------------------------
  // Tier 1 — User
  // ----------------------------------------------------------------------

  async getCurrentUsername() {
    return this._currentUsername;
  }

  async getCurrentUser() {
    const u = this._users.get(this._currentUsername);
    return u ? this._wrapUser(u) : undefined;
  }

  async getAppUser() {
    // Phase 1: app user is the same as current user (no separate app identity)
    return this.getCurrentUser();
  }

  async getUserByUsername(username) {
    const u = this._users.get(username);
    return u ? this._wrapUser(u) : undefined;
  }

  async getUserById(id) {
    const u = this._usersById.get(id);
    return u ? this._wrapUser(u) : undefined;
  }

  async getSnoovatarUrl(username) {
    const u = this._users.get(username);
    return u?.snoovatar ?? undefined;
  }

  // ----------------------------------------------------------------------
  // Tier 1 — Subreddit
  // ----------------------------------------------------------------------

  async getCurrentSubredditName() {
    return this._currentSubredditName;
  }

  async getCurrentSubreddit() {
    const s = this._subreddits.get(this._currentSubredditName.toLowerCase());
    return s ? this._wrapSubreddit(s) : undefined;
  }

  async getSubredditByName(name) {
    const s = this._subreddits.get(name.toLowerCase());
    return s ? this._wrapSubreddit(s) : undefined;
  }

  async getSubredditInfoByName(name) {
    return this.getSubredditByName(name);
  }

  async getSubredditById(id) {
    const s = this._subredditsById.get(id);
    return s ? this._wrapSubreddit(s) : undefined;
  }

  async getSubredditInfoById(id) {
    return this.getSubredditById(id);
  }

  // ----------------------------------------------------------------------
  // Tier 2 — Posts
  // ----------------------------------------------------------------------

  async getPostById(id) {
    const p = this._posts.get(id);
    return p ? this._wrapPost(p) : undefined;
  }

  async submitPost(options) {
    this._counters.post++;
    const id = makeId('t3', this._counters.post + Date.now() % 100000);
    const subredditName = options.subredditName || this._currentSubredditName;
    const post = {
      id,
      name: id,
      authorName: this._currentUsername,
      subredditName,
      title: options.title || '',
      url: options.url,
      body: options.text || options.body,
      kind: options.url ? 'link' : 'self',
      score: 1,
      createdUtc: Math.floor(Date.now() / 1000),
      thumbnail: options.url ? 'default' : 'self',
    };
    this._posts.set(id, post);
    this._schedulePersist();
    return this._wrapPost(post);
  }

  async submitCustomPost(options) {
    // Phase 1: same shape as submitPost — experience post metadata ignored
    return this.submitPost(options);
  }

  async getPostsByUser(options) {
    // Don't strip prefix — the caller passes whatever shape the API expects,
    // and our seeded users use the 'u/<name>' convention.
    const username = options.username;
    const out = [];
    for (const p of this._posts.values()) {
      if (p.authorName === username) out.push(this._wrapPost(p));
    }
    return this._listing(out);
  }

  async getNewPosts(options) {
    return this._filterBySubreddit(this._posts, options.subredditName, 'createdUtc');
  }

  async getHotPosts(options) {
    return this._filterBySubreddit(this._posts, options.subredditName, 'score');
  }

  async getTopPosts(options) {
    return this._filterBySubreddit(this._posts, options.subredditName, 'score');
  }

  async getControversialPosts(options) {
    return this._filterBySubreddit(this._posts, options.subredditName, 'score');
  }

  async getRisingPosts(options) {
    return this._filterBySubreddit(this._posts, options.subredditName, 'createdUtc');
  }

  // ----------------------------------------------------------------------
  // Farnsworth IDE admin surface
  // ----------------------------------------------------------------------

  // Plain-JSON view of the live store for Farnsworth's Post View.
  // Reads go through the running process rather than the JSON state file on
  // purpose: that file is a debounced projection of these maps, so anything
  // written out-of-band is clobbered by the next flush.
  adminSnapshot() {
    return {
      currentUsername: this._currentUsername,
      currentSubredditName: this._currentSubredditName,
      posts: Array.from(this._posts.values()),
      comments: Array.from(this._comments.values()),
      counters: { ...this._counters },
    };
  }

  // ----------------------------------------------------------------------
  // Tier 2 — Comments
  // ----------------------------------------------------------------------

  async submitComment(options) {
    this._counters.comment++;
    const id = makeId('t1', this._counters.comment + Date.now() % 100000);
    const comment = {
      id,
      authorName: this._currentUsername,
      body: options.text || options.body || '',
      createdUtc: Math.floor(Date.now() / 1000),
      score: 1,
      parentId: options.id,
      linkId: options.id.startsWith('t1_') ? undefined : options.id,
      subredditName: this._currentSubredditName,
    };
    this._comments.set(id, comment);
    this._schedulePersist();
    return this._wrapComment(comment);
  }

  async getComments(options) {
    const out = [];
    for (const c of this._comments.values()) {
      if (options.postId && c.linkId !== options.postId) continue;
      if (options.commentId && c.parentId !== options.commentId) continue;
      out.push(this._wrapComment(c));
    }
    return this._listing(out);
  }

  async getCommentsByUser(options) {
    const username = options.username;
    const out = [];
    for (const c of this._comments.values()) {
      if (c.authorName === username) out.push(this._wrapComment(c));
    }
    return this._listing(out);
  }

  async getCommentById(id) {
    const c = this._comments.get(id);
    return c ? this._wrapComment(c) : undefined;
  }

  // ----------------------------------------------------------------------
  // Tier 2 — Flairs
  // ----------------------------------------------------------------------

  async setUserFlair(options) {
    const subredditName = options.subredditName?.toLowerCase();
    const username = options.username;
    const key = `${subredditName}:${username}`;
    this._flairs.set(key, {
      text: options.text || '',
      flairTemplateId: options.flairTemplateId,
      cssClass: options.cssClass,
      backgroundColor: options.backgroundColor,
      textColor: options.textColor,
    });
    this._schedulePersist();
  }

  async removeUserFlair(subredditName, username) {
    const key = `${subredditName.toLowerCase()}:${username}`;
    this._flairs.delete(key);
    this._schedulePersist();
  }

  // ----------------------------------------------------------------------
  // Tier 2 — Mod actions (Phase 1 minimal — used by the-last-draft admin)
  // ----------------------------------------------------------------------

  async getApprovedUsers(options) {
    return this._listing([]);
  }

  async getBannedUsers(options) {
    return this._listing([]);
  }

  async getModerators(options) {
    return this._listing([]);
  }

  // ----------------------------------------------------------------------
  // Tier 2 — Wiki (Phase 1 minimal)
  // ----------------------------------------------------------------------

  async getWikiPage(subredditName, page) {
    return {
      subredditName,
      page,
      content: '',
      revisionId: 'wikiv_revision_0',
      reason: '',
      mayRevise: true,
    };
  }

  async getWikiPages(subredditName) {
    return [];
  }

  // ----------------------------------------------------------------------
  // Tier 2 — GraphQL query (Phase 1: pass-through stub)
  // ----------------------------------------------------------------------

  async query(_options) {
    // Phase 1: GraphQL is not implemented; return empty listing shape.
    return { data: {}, errors: [{ message: 'GraphQL not implemented in devvit-emulator Phase 1' }] };
  }

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------

  _filterBySubreddit(map, subredditName, sortKey) {
    const out = [];
    for (const p of map.values()) {
      if (subredditName && p.subredditName !== subredditName) continue;
      out.push(this._wrapPost(p));
    }
    out.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    return this._listing(out);
  }

  _listing(items) {
    // Mock the Devvit Listing<T> shape — has .all(), .length, [Symbol.iterator]
    let cursor = 0;
    return {
      length: items.length,
      async all() {
        return items.slice();
      },
      async next() {
        if (cursor >= items.length) return { done: true, value: undefined };
        return { done: false, value: items[cursor++] };
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => this.next(),
        };
      },
    };
  }

  // ----------------------------------------------------------------------
  // Debug / introspection — not part of the RedditAPIClient API
  // ----------------------------------------------------------------------

  _dump() {
    return {
      currentUsername: this._currentUsername,
      currentSubredditName: this._currentSubredditName,
      users: Array.from(this._users.values()),
      subreddits: Array.from(this._subreddits.values()),
      posts: Array.from(this._posts.values()),
      comments: Array.from(this._comments.values()),
      flairs: Array.from(this._flairs.entries()).map(([key, value]) => ({ key, value })),
    };
  }

  _clearRedditState() {
    this._posts.clear();
    this._comments.clear();
    this._flairs.clear();
    this._counters = { post: 0, comment: 0, subreddit: 0, user: 0 };
    this._schedulePersist();
  }
}