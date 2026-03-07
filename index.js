// Qobuz Search Plugin V4
// Multi-provider search/stream with jumo-dl, YAMS, Paxsenix fallback chain

(function () {
  "use strict";

  const SOURCE_TYPE = "qobuz";

  const DEBUG = false; // Set to true to enable verbose API response logging

  const JUMO_BASE    = "https://jumo-dl.pages.dev";
  const JUMO_HEADERS = {
    "Accept":     "application/json",
    "Referer":    "https://jumo-dl.pages.dev/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
  };

  const YAMS_SEARCH_BASE = "https://api.yams.tf/search";

  const PAX_BASE = "https://api.paxsenix.org/dl/qobuz";

  // API key helpers — stored in localStorage
  function getPaxKey() {
    const raw = localStorage.getItem("qobuz_pax_api_key") || "";
    return raw.trim();
  }
  function getPaxAuth() {
    const key = getPaxKey();
    if (!key) return null;
    // Accept keys with or without the "Bearer " prefix
    return key.startsWith("Bearer ") ? key : `Bearer ${key}`;
  }

  // dabmusic kept for artist discography — no alternative exists
  const DAB_BASE = "https://dabmusic.xyz/api";

  const QOBUZ_QUALITIES = ["320kbps", "CD", "Hi-Res", "Studio Quality"];
  const DEFAULT_QUALITY  = "Studio Quality";

  // SVG Icons definition
  const ICONS = {
    search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
    mic: `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
    heart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
    heartOutline: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
    download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`
  };

  const QobuzSearch = {
    name: "Qobuz Search",
    api: null,
    isOpen: false,
    searchTimeout: null,
    libraryTracks: new Set(),

    searchCache: {},
    _currentQuery: "",
    _scrollCache: {},
    hasNewChanges: false,

    state: {
      view: "search",
      searchType: "track",
      currentData: null,
      history: [],
      currentTitle: ""
    },

    isPlaying: null,

    init(api) {
      console.log("[QobuzSearch] Initializing...");
      this.api = api;
      this.fetchLibraryTracks();
      this.injectStyles();
      this.createSearchPanel();
      this.createPlayerBarButton();

      setTimeout(() => this.createPlayerBarButton(), 500);

      if (api.stream && api.stream.registerResolver) {
        api.stream.registerResolver(SOURCE_TYPE, async (externalId, options) => {
          try {
            const streamData = await this.fetchStream(externalId);
            return streamData.url;
          } catch (err) {
            console.error("[QobuzSearch] Stream resolve error:", err);
            return null;
          }
        });
      }

      // Register searchCover request handler for inter-plugin use
      if (api.handleRequest) {
        api.handleRequest("searchCover", async (data) => {
          const { title, artist, trackId, requester } = data;
          console.log(`[QobuzSearch] Cover search requested by: ${requester || "unknown"}`);
          return await this.searchCoverForRPC(title, artist, trackId);
        });
        console.log("[QobuzSearch] Registered 'searchCover' request handler");
      }
    },

    async fetchLibraryTracks() {
      if (this.api?.library?.getTracks) {
        try {
          const tracks = (await this.api.library.getTracks()) || [];
          if (!Array.isArray(tracks)) {
            this.libraryTracks = new Set();
            return;
          }
          this.libraryTracks = new Set(
            tracks
              .filter((t) => t && t.source_type === SOURCE_TYPE)
              .map((t) => t.external_id)
          );
        } catch (err) {
          console.error("[QobuzSearch] Failed to fetch library tracks:", err);
        }
      }
    },

    formatDuration(sec) {
      if (!sec) return "--:--";
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${m}:${s.toString().padStart(2, '0')}`;
    },

    escapeHtml(str) {
      if (!str) return "";
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    },

    // STYLES

    injectStyles() {
      if (document.getElementById("qobuz-search-styles-v4")) return;
      const style = document.createElement("style");
      style.id = "qobuz-search-styles-v4";
      style.textContent = `
        /* Core Panels */
        #qobuz-search-panel { 
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95); 
          background: var(--bg-elevated, #181818); 
          border: 1px solid var(--border-color, #333); 
          border-radius: 12px; padding: 0; width: 700px; height: 95vh; max-height: 95vh; z-index: 10001; 
          box-shadow: 0 20px 50px rgba(0,0,0,0.5); 
          opacity: 0; visibility: hidden; 
          transition: all 0.2s cubic-bezier(0, 0, 0.2, 1); 
          display: flex; flex-direction: column; overflow: hidden; position: fixed;
        }
        #qobuz-search-panel.open { opacity: 1; visibility: visible; transform: translate(-50%, -50%) scale(1); }
        #qobuz-search-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px); z-index: 10000; opacity: 0; visibility: hidden; transition: opacity 0.2s; }
        #qobuz-search-overlay.open { opacity: 1; visibility: visible; }

        /* Header */
        .qobuz-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); display: flex; align-items: center; gap: 16px; background: var(--bg-elevated, #181818); flex-shrink: 0; }
        .qobuz-back-btn { background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; padding: 8px; border-radius: 50%; transition: 0.2s; display: flex; align-items: center; justify-content: center; }
        .qobuz-back-btn:hover { background: var(--bg-highlight, #333); color: var(--text-primary, #fff); }
        .qobuz-title { font-size: 18px; font-weight: 700; color: var(--text-primary, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .qobuz-close-btn { margin-left: auto; background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 20px; transition: 0.2s; }
        .qobuz-close-btn:hover { color: var(--text-primary, #fff); }

        /* Controls */
        .qobuz-controls { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); background: var(--bg-elevated, #181818); }
        .qobuz-search-row { display: flex; flex-direction: column; gap: 12px; }
        .qobuz-input-wrapper { position: relative; }
        .qobuz-input { width: 100%; padding: 10px 16px 10px 40px; border-radius: 8px; border: 1px solid var(--border-color, #404040); background: #1a1a1a !important; color: #fff !important; font-size: 14px; outline: none; transition: border-color 0.2s; box-sizing: border-box; -webkit-text-fill-color: #fff !important; color-scheme: dark; }
        .qobuz-input::placeholder { color: #555 !important; -webkit-text-fill-color: #555 !important; }
        .qobuz-input:focus { border-color: var(--accent-primary, #1a62b9); background: #1a1a1a !important; }
        .qobuz-input-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-subdued, #666); display: flex; align-items: center; }

        .qobuz-tabs { display: flex; background: var(--bg-surface, #202020); padding: 4px; border-radius: 8px; gap: 4px; }
        .qobuz-tab { flex: 1; border: none; background: transparent; color: var(--text-secondary, #888); padding: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 6px; transition: 0.2s; }
        .qobuz-tab:hover { color: var(--text-primary, #fff); background: rgba(255,255,255,0.05); }
        .qobuz-tab.active { background: var(--bg-highlight, #2a2a2a); color: var(--text-primary, #fff); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }

        .qobuz-quality-row { display: flex; align-items: center; gap: 8px; }
        .qobuz-quality-label { font-size: 11px; color: var(--text-subdued, #666); white-space: nowrap; }
        .qobuz-quality-select { background: var(--bg-surface, #202020); border: 1px solid var(--border-color, #404040); border-radius: 6px; color: var(--text-primary, #fff); padding: 6px 10px; font-size: 12px; cursor: pointer; flex: 1; }

        /* Content */
        .qobuz-content { flex: 1; overflow-y: auto; padding: 0; position: relative; background: var(--bg-base, #121212); }
        .qobuz-content::-webkit-scrollbar { width: 8px; }
        .qobuz-content::-webkit-scrollbar-thumb { background: var(--bg-highlight, #333); border-radius: 4px; }

        /* Hero Section */
        .qobuz-hero { padding: 24px; display: flex; gap: 24px; background: linear-gradient(to bottom, rgba(26, 98, 185, 0.1), transparent); }
        .qobuz-hero-cover { width: 160px; height: 160px; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); object-fit: cover; background: var(--bg-surface, #202020); flex-shrink: 0;}
        .qobuz-hero-info { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 4px; }
        .qobuz-hero-type { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; color: var(--text-secondary, #aaa); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
        .qobuz-hero-title { font-size: 28px; font-weight: 800; color: var(--text-primary, #fff); line-height: 1.2; margin-bottom: 12px; }
        .qobuz-hero-meta { font-size: 13px; color: var(--text-secondary, #ccc); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .qobuz-badge { background: var(--accent-primary, #1a62b9); color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 800; display: inline-block; vertical-align: middle; line-height: 1.4; }
        .qobuz-explicit-badge { background: var(--text-subdued, #555); color: var(--bg-base, #121212); padding: 1px 4px; border-radius: 2px; font-size: 9px; font-weight: 700; display: inline-block; vertical-align: middle; line-height: 1.4; flex-shrink: 0; }

        .qobuz-missing-warning { margin: 0 16px 16px; padding: 10px 14px; background: rgba(255,180,0,0.1); border: 1px solid rgba(255,180,0,0.3); border-radius: 6px; color: #ffb400; font-size: 12px; }

        /* Save All Button */
        .qobuz-save-all-btn {
            background: transparent; border: 1px solid var(--border-color, #444); color: var(--text-primary, #fff);
            padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer;
            display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; transition: 0.2s;
        }
        .qobuz-save-all-btn:hover { border-color: var(--accent-primary, #1a62b9); color: var(--accent-primary, #1a62b9); }

        /* Track List */
        .qobuz-track-list { padding: 8px 16px 24px; }
        .qobuz-track-item { display: grid; grid-template-columns: 48px 1fr auto auto; align-items: center; gap: 12px; padding: 8px; border-radius: 6px; cursor: pointer; transition: 0.2s; border-bottom: 1px solid rgba(255,255,255,0.03); }
        .qobuz-track-item:hover { background: var(--bg-surface, #202020); }
        .qobuz-track-item.playing { background: rgba(26,98,185,0.08); }
        .qobuz-track-item.playing .qobuz-track-title { color: var(--accent-primary, #1a62b9); }
        
        .qobuz-track-cover-wrapper { position: relative; width: 48px; height: 48px; border-radius: 4px; overflow: hidden; background: #2a2a2a; flex-shrink: 0; }
        .qobuz-track-cover { width: 100%; height: 100%; object-fit: cover; }
        .qobuz-play-overlay {
            position: absolute; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
            opacity: 0; transition: 0.2s; color: white;
        }
        .qobuz-track-item:hover .qobuz-play-overlay { opacity: 1; }
        .qobuz-track-item.playing .qobuz-play-overlay { opacity: 1; background: rgba(0,0,0,0.5); color: white; }

        .qobuz-track-title { font-size: 14px; color: var(--text-primary, #fff); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
        .qobuz-track-artist { font-size: 12px; color: var(--text-secondary, #888); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .qobuz-track-time { color: var(--text-subdued, #666); font-size: 12px; font-variant-numeric: tabular-nums; }
        
        /* Clickable Artist */
        .qobuz-clickable-artist { cursor: pointer; transition: color 0.2s; }
        .qobuz-clickable-artist:hover { color: var(--accent-primary, #1a62b9); text-decoration: underline; }

        .qobuz-track-actions { display: flex; align-items: center; gap: 8px; opacity: 0; transition: 0.2s; }
        .qobuz-track-item:hover .qobuz-track-actions { opacity: 1; }
        .qobuz-save-btn-mini { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
        .qobuz-save-btn-mini:hover { color: var(--text-primary); transform: scale(1.1); }
        .qobuz-save-btn-mini.saved { color: var(--accent-primary); opacity: 1 !important; }
        .qobuz-track-item .qobuz-save-btn-mini.saved { opacity: 1; }

        /* Grid Items */
        .qobuz-grid-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; padding: 20px; }
        .qobuz-card { background: var(--bg-elevated, #181818); padding: 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s; border: 1px solid transparent; }
        .qobuz-card:hover { background: var(--bg-surface, #202020); transform: translateY(-4px); border-color: var(--bg-highlight, #333); }
        .qobuz-card-img { width: 100%; aspect-ratio: 1; border-radius: 6px; object-fit: cover; background: var(--bg-surface, #202020); margin-bottom: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .qobuz-card-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
        .qobuz-card-sub { font-size: 12px; color: var(--text-secondary, #888); display: flex; align-items: center; gap: 4px; overflow: hidden; }
        .qobuz-card-sub-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
        .qobuz-card-sub-count { white-space: nowrap; flex-shrink: 0; color: var(--text-subdued, #666); }

        .qobuz-unavailable { text-align: center; padding: 40px 24px; color: var(--text-subdued, #666); font-size: 13px; }
        .qobuz-unavailable-icon { font-size: 32px; margin-bottom: 12px; }

        /* Skeleton Loading */
        .qobux-skeleton { background: #2a2a2a; border-radius: 4px; animation: qobux-pulse 1.5s infinite ease-in-out; }
        @keyframes qobux-pulse { 0% { opacity: 0.4; } 50% { opacity: 0.7; } 100% { opacity: 0.4; } }
        .qobux-skeleton-row { height: 56px; margin-bottom: 8px; border-radius: 8px; background: #222; animation: qobux-pulse 1.5s infinite; }
        .qobux-skeleton-card { aspect-ratio: 1; border-radius: 6px; background: #222; animation: qobux-pulse 1.5s infinite; }

        /* Player Bar Button */
        .qobuz-playerbar-btn { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 20px; border: 1px solid var(--border-color, #404040); background: transparent; color: #fff; cursor: pointer; font-size: 13px; font-weight: 700; transition: 0.2s; }
        .qobuz-playerbar-btn:hover { background: var(--bg-highlight, #2a2a2a); border-color: var(--accent-primary, #1a62b9); transform: scale(1.05); }
        .qobuz-playerbar-btn svg { fill: var(--accent-primary, #1a62b9); width: 16px; height: 16px; }

        .hidden { display: none !important; }
        .text-center { text-align: center; color: var(--text-subdued, #666); margin-top: 60px; font-size: 14px; }

        /* Settings */
        .qobuz-settings-btn { background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; padding: 8px; border-radius: 50%; transition: 0.2s; display: flex; align-items: center; justify-content: center; margin-left: 6px; }
        .qobuz-settings-btn:hover { background: var(--bg-highlight, #333); color: var(--text-primary, #fff); }

        #qobuz-settings-panel {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: var(--bg-elevated, #181818);
          border-radius: 12px;
          z-index: 10; display: flex; flex-direction: column;
          opacity: 0; visibility: hidden; transform: translateY(8px);
          transition: all 0.2s cubic-bezier(0, 0, 0.2, 1);
        }
        #qobuz-settings-panel.open { opacity: 1; visibility: visible; transform: translateY(0); }

        .qobuz-settings-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color, #333); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .qobuz-settings-header .qobuz-title { font-size: 16px; font-weight: 700; color: var(--text-primary, #fff); }
        .qobuz-settings-close { margin-left: auto; background: none; border: none; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 20px; transition: 0.2s; }
        .qobuz-settings-close:hover { color: var(--text-primary, #fff); }

        .qobuz-settings-body { flex: 1; overflow-y: auto; padding: 24px; }
        .qobuz-settings-body::-webkit-scrollbar { width: 8px; }
        .qobuz-settings-body::-webkit-scrollbar-thumb { background: var(--bg-highlight, #333); border-radius: 4px; }

        .qobuz-settings-section-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-secondary, #aaa); margin-bottom: 16px; }

        .qobuz-api-key-row { display: flex; gap: 8px; margin-bottom: 8px; }
        .qobuz-api-key-input { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-color, #404040); background: var(--bg-surface, #202020); color: var(--text-primary, #fff); font-size: 13px; font-family: monospace; outline: none; transition: border-color 0.2s; }
        .qobuz-api-key-input:focus { border-color: var(--accent-primary, #1a62b9); }
        .qobuz-api-key-save { padding: 10px 20px; background: var(--accent-primary, #1a62b9); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: 0.2s; }
        .qobuz-api-key-save:hover { filter: brightness(1.15); }
        .qobuz-api-key-status { font-size: 12px; margin-bottom: 24px; min-height: 18px; }
        .qobuz-api-key-status.ok { color: #4caf50; }
        .qobuz-api-key-status.missing { color: #f55; }

        .qobuz-steps { list-style: none; padding: 0; margin: 0; counter-reset: steps; }
        .qobuz-steps li { counter-increment: steps; display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border-color, #222); font-size: 13px; color: var(--text-secondary, #ccc); line-height: 1.5; }
        .qobuz-steps li:last-child { border-bottom: none; }
        .qobuz-steps li::before { content: counter(steps); min-width: 24px; height: 24px; border-radius: 50%; background: var(--accent-primary, #1a62b9); color: #fff; font-size: 11px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
        .qobuz-steps a { color: var(--accent-primary, #1a62b9); text-decoration: none; }
        .qobuz-steps a:hover { text-decoration: underline; }
        .qobuz-steps code { background: var(--bg-surface, #202020); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 12px; color: var(--text-primary, #fff); }

        /* Bulk save progress bar */
        #qobuz-save-progress {
          position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
          background: var(--bg-elevated, #282828); color: var(--text-primary, #fff);
          padding: 16px 32px; border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          z-index: 10002; display: flex; flex-direction: column; align-items: center;
          min-width: 320px; max-width: 400px; text-align: center;
        }
        #qobuz-save-progress.hidden { display: none; }
        .qobuz-progress-bar {
          width: 100%; height: 8px; background: var(--bg-highlight, #3e3e3e);
          border-radius: 4px; margin-bottom: 12px; overflow: hidden; position: relative;
        }
        .qobuz-progress-bar-inner {
          height: 100%; background: var(--accent-primary, #1a62b9);
          border-radius: 4px; width: 0%; transition: width 0.2s;
          position: absolute; left: 0; top: 0;
        }
        .qobuz-progress-text { font-size: 14px; color: var(--text-primary, #fff); }

        .qobuz-artist-avatar {
          width: 160px; height: 160px; border-radius: 50%; flex-shrink: 0;
          background: linear-gradient(135deg, var(--accent-primary, #1a62b9), #0d3d73);
          display: flex; align-items: center; justify-content: center;
          font-size: 52px; font-weight: 800; color: rgba(255,255,255,0.9);
          box-shadow: 0 8px 24px rgba(0,0,0,0.4); letter-spacing: -2px;
          user-select: none;
        }

        .qobuz-artist-card-avatar {
          width: 100%; aspect-ratio: 1; border-radius: 50%; margin-bottom: 12px;
          background: linear-gradient(135deg, var(--accent-primary, #1a62b9), #0d3d73);
          display: flex; align-items: center; justify-content: center;
          font-size: 36px; font-weight: 800; color: rgba(255,255,255,0.9);
          box-shadow: 0 4px 12px rgba(0,0,0,0.2); letter-spacing: -1px;
          user-select: none;
        }

        .qobuz-section-header {
          padding: 16px 24px 8px;
          font-size: 16px; font-weight: 700;
          color: var(--text-primary, #fff);
          border-top: 1px solid var(--border-color, #222);
          margin-top: 8px;
        }

        @media (max-width: 768px) {
          #qobuz-search-panel { width: 100vw; height: 100vh; max-height: 100vh; top: 0; left: 0; transform: none; border-radius: 0; border: none; }
          #qobuz-search-panel.open { transform: none; }
          .qobuz-header { padding: 12px 16px; gap: 12px; }
          .qobuz-back-btn, .qobuz-close-btn { min-width: 44px; min-height: 44px; -webkit-tap-highlight-color: transparent; }
          .qobuz-title { font-size: 16px; }
          .qobuz-controls { padding: 12px 16px; }
          .qobuz-input { font-size: 16px; padding: 12px 16px 12px 40px; }
          .qobuz-tab { padding: 10px; min-height: 44px; -webkit-tap-highlight-color: transparent; }
          .qobuz-content { padding-bottom: calc(60px + 64px); }
          .qobuz-hero { flex-direction: column; align-items: center; text-align: center; padding: 16px; gap: 16px; }
          .qobuz-hero-cover { width: 140px; height: 140px; }
          .qobuz-hero-title { font-size: 20px; }
          .qobuz-hero-meta { justify-content: center; }
          .qobuz-save-all-btn { padding: 10px 16px; min-height: 44px; -webkit-tap-highlight-color: transparent; }
          .qobuz-track-item { grid-template-columns: 44px 1fr auto auto; padding: 10px 8px; -webkit-tap-highlight-color: transparent; }
          .qobuz-track-actions { opacity: 1; }
          .qobuz-save-btn-mini { min-width: 44px; min-height: 44px; -webkit-tap-highlight-color: transparent; }
          .qobuz-play-overlay { display: none; }
          .qobuz-grid-list { grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 12px; }
          .qobuz-card { -webkit-tap-highlight-color: transparent; }
          .qobuz-artist-avatar { width: 120px; height: 120px; font-size: 40px; }
          .qobuz-clickable-artist { min-height: 44px; display: inline-flex; align-items: center; -webkit-tap-highlight-color: transparent; }
        }
      `;
      document.head.appendChild(style);
    },

    // UI SETUP
    
    createSearchPanel() {
      const overlay = document.createElement("div");
      overlay.id = "qobuz-search-overlay";
      overlay.onclick = () => this.close();
      document.body.appendChild(overlay);

      // Progress bar for bulk saves
      const progressEl = document.createElement("div");
      progressEl.id = "qobuz-save-progress";
      progressEl.className = "hidden";
      progressEl.innerHTML = `
        <div class="qobuz-progress-bar"><div class="qobuz-progress-bar-inner"></div></div>
        <div class="qobuz-progress-text"></div>
      `;
      document.body.appendChild(progressEl);

      const panel = document.createElement("div");
      panel.id = "qobuz-search-panel";
      panel.innerHTML = `
        <div class="qobuz-header">
          <button id="qobuz-back-btn" class="qobuz-back-btn hidden" title="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </button>
          <div class="qobuz-title" id="qobuz-panel-title">Qobuz Search</div>
          <button id="qobuz-settings-btn" class="qobuz-settings-btn" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button class="qobuz-close-btn" title="Close">✕</button>
        </div>

        <div id="qobuz-settings-panel">
          <div class="qobuz-settings-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary,#aaa)"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <div class="qobuz-title">Settings</div>
            <button class="qobuz-settings-close" title="Close settings">✕</button>
          </div>
          <div class="qobuz-settings-body">
            <div class="qobuz-settings-section-title">Paxsenix API Key</div>
            <div class="qobuz-api-key-row">
              <input type="password" id="qobuz-pax-key-input" class="qobuz-api-key-input" placeholder="sk-paxsenix-…" autocomplete="off" spellcheck="false">
              <button id="qobuz-pax-key-save" class="qobuz-api-key-save">Save</button>
            </div>
            <div id="qobuz-pax-key-status" class="qobuz-api-key-status"></div>

            <div class="qobuz-settings-section-title">How to get your API key</div>
            <ol class="qobuz-steps">
              <li>Visit <a href="https://api.paxsenix.org/dashboard#api-keys" target="_blank" rel="noopener">api.paxsenix.org/dashboard</a> in your browser.</li>
              <li>Click <strong>Sign in with GitHub</strong>. Create a GitHub account first if you don't have one.</li>
              <li>Complete sign-in, then click <strong>Authorize paxsenix</strong> when prompted.</li>
              <li>In the left sidebar, click <strong>API Keys</strong>.</li>
              <li>At the bottom of the screen, click the <strong>Copy Key</strong> button.</li>
              <li>Paste the key (looks like <code>sk-paxsenix-…</code>) into the field above and click <strong>Save</strong>.</li>
            </ol>
          </div>
        </div>
        
        <div id="qobuz-controls-area" class="qobuz-controls">
          <div class="qobuz-search-row">
            <div class="qobuz-input-wrapper">
              <div class="qobuz-input-icon">${ICONS.search}</div>
              <input type="text" id="qobuz-search-input" class="qobuz-input" placeholder="Search tracks, albums, artists...">
            </div>
            <div class="qobuz-tabs" id="qobuz-search-tabs">
              <button class="qobuz-tab active" data-type="track">Tracks</button>
              <button class="qobuz-tab" data-type="album">Albums</button>
              <button class="qobuz-tab" data-type="artist">Artists</button>
            </div>
            <div class="qobuz-quality-row">
              <label class="qobuz-quality-label">Quality</label>
              <select id="qobuz-quality-select" class="qobuz-quality-select">
                <option value="320kbps">320 kbps</option>
                <option value="CD">CD Lossless</option>
                <option value="Hi-Res">Hi-Res</option>
                <option value="Studio Quality" selected>Studio Quality</option>
              </select>
            </div>
          </div>
        </div>

        <div id="qobuz-content-area" class="qobuz-content"></div>
      `;
      document.body.appendChild(panel);

      panel.querySelector(".qobuz-close-btn").onclick = () => this.close();
      panel.querySelector("#qobuz-back-btn").onclick = () => this.goBack();

      // Settings panel 
      const settingsPanel = panel.querySelector("#qobuz-settings-panel");
      const keyInput      = panel.querySelector("#qobuz-pax-key-input");
      const keyStatus     = panel.querySelector("#qobuz-pax-key-status");

      const refreshKeyStatus = () => {
        const key = getPaxKey();
        if (key) {
          keyStatus.className = "qobuz-api-key-status ok";
          keyStatus.textContent = "✓ API key saved";
          keyInput.value = key;
        } else {
          keyStatus.className = "qobuz-api-key-status missing";
          keyStatus.textContent = "No API key saved. Streaming via Paxsenix will be unavailable.";
          keyInput.value = "";
        }
      };

      panel.querySelector("#qobuz-settings-btn").onclick = () => {
        refreshKeyStatus();
        settingsPanel.classList.add("open");
      };
      panel.querySelector(".qobuz-settings-close").onclick = () => {
        settingsPanel.classList.remove("open");
      };
      panel.querySelector("#qobuz-pax-key-save").onclick = () => {
        const val = keyInput.value.trim();
        if (!val) {
          localStorage.removeItem("qobuz_pax_api_key");
          keyStatus.className = "qobuz-api-key-status missing";
          keyStatus.textContent = "API key cleared.";
          return;
        }
        localStorage.setItem("qobuz_pax_api_key", val);
        keyStatus.className = "qobuz-api-key-status ok";
        keyStatus.textContent = "✓ API key saved!";
        setTimeout(() => settingsPanel.classList.remove("open"), 800);
      };
      
      const input = panel.querySelector("#qobuz-search-input");

      input.addEventListener("input", (e) => {
        this._currentQuery = e.target.value.trim();
        this.handleSearch(e.target.value);
      });

      panel.querySelectorAll(".qobuz-tab").forEach(btn => {
        btn.onclick = () => {
          const container = document.getElementById("qobuz-content-area");
          const currentKey = `${this.state.searchType}:${this._currentQuery}`;
          if (container) this._scrollCache[currentKey] = container.scrollTop;

          this.state.searchType = btn.dataset.type;
          panel.querySelectorAll(".qobuz-tab").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          if (input.value) this.handleSearch(input.value);

          const newKey = `${this.state.searchType}:${this._currentQuery}`;
          const savedScroll = this._scrollCache[newKey];
          if (savedScroll !== undefined) {
            setTimeout(() => { if (container) container.scrollTop = savedScroll; }, 0);
          }
        };
      });
    },

    createPlayerBarButton() {
      if (document.getElementById("qobuz-search-btn")) return;
      const btn = document.createElement("button");
      btn.id = "qobuz-search-btn";
      btn.className = "qobuz-playerbar-btn";
      btn.innerHTML = `
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-9l6 4.5-6 4.5z"/></svg>
        <span>Qobuz</span>
      `;
      btn.onclick = () => this.open();
      if (this.api?.ui?.registerSlot) {
        this.api.ui.registerSlot("playerbar:menu", btn);
      }
    },

    // ═══════════════════════════════════════════════════════════════════
    // NAVIGATION
    // ═══════════════════════════════════════════════════════════════════

    open() {
      this.isOpen = true;
      document.getElementById("qobuz-search-overlay")?.classList.add("open");
      document.getElementById("qobuz-search-panel")?.classList.add("open");
      // Refresh library tracks so heart icons reflect any external changes
      this.fetchLibraryTracks();
      setTimeout(() => document.querySelector("#qobuz-search-input")?.focus(), 100);
    },

    close() {
      this.isOpen = false;
      document.getElementById("qobuz-search-overlay")?.classList.remove("open");
      document.getElementById("qobuz-search-panel")?.classList.remove("open");
      if (this.hasNewChanges) {
        this.api?.library?.refresh?.();
        this.hasNewChanges = false;
      }
      // Clear search cache so results are fresh on next open
      this.searchCache   = {};
      this._currentQuery = "";
    },

    navigateTo(view, data, title) {
      const container = document.getElementById("qobuz-content-area");
      const scrollKey = `${this.state.view}:${this.state.currentTitle}`;
      if (container) this._scrollCache[scrollKey] = container.scrollTop;

      // Capture current search input value so goBack can restore it
      const currentQuery = this.state.view === "search"
        ? (document.getElementById("qobuz-search-input")?.value ?? "")
        : null;

      this.state.history.push({
        view:       this.state.view,
        data:       this.state.currentData,
        title:      this.state.currentTitle,
        query:      currentQuery,
        searchType: this.state.view === "search" ? this.state.searchType : null,
      });
      this.state.view         = view;
      this.state.currentData  = data;
      this.state.currentTitle = title;
      this.updateHeader();
      this.render();
    },

    goBack(forceReset = false) {
      if (forceReset) {
        this.state.history = [];
        this.state.view = 'search';
        this.state.currentData = null;
        this.state.currentTitle = "Qobuz Search";
        this.updateHeader();
        this.render();
        return;
      }
      if (this.state.history.length > 0) {
        const prev = this.state.history.pop();
        this.state.view = prev.view;
        this.state.currentData = prev.data;
        this.state.currentTitle = prev.title;
        this.updateHeader();
        // Restore search state
        if (prev.view === "search") {
          const input = document.getElementById("qobuz-search-input");
          if (input) input.value = prev.query ?? "";
          if (prev.searchType) {
            this.state.searchType = prev.searchType;
            document.querySelectorAll(".qobuz-tab").forEach(b => {
              b.classList.toggle("active", b.dataset.type === prev.searchType);
            });
          }
        }
        this.render();
        const scrollKey = `${prev.view}:${prev.title}`;
        const savedScroll = this._scrollCache[scrollKey];
        if (savedScroll !== undefined) {
          const container = document.getElementById("qobuz-content-area");
          if (container) setTimeout(() => { container.scrollTop = savedScroll; }, 0);
        }
      } else {
        this.close();
      }
    },

    updateHeader() {
      const backBtn = document.getElementById("qobuz-back-btn");
      const title = document.getElementById("qobuz-panel-title");
      const controls = document.getElementById("qobuz-controls-area");
      title.textContent = this.state.currentTitle;
      if (this.state.view === 'search') {
        backBtn.classList.add("hidden");
        controls.classList.remove("hidden");
      } else {
        backBtn.classList.remove("hidden");
        controls.classList.add("hidden");
      }
    },

    // ═══════════════════════════════════════════════════════════════════
    // DATA FETCHING
    // ═══════════════════════════════════════════════════════════════════

    handleSearch(query) {
      clearTimeout(this.searchTimeout);
      const container = document.getElementById("qobuz-content-area");
      if (!query.trim()) {
        this.searchCache   = {};
        this._scrollCache  = {};
        this._currentQuery = "";
        container.innerHTML = `<div class="text-center">Start typing to search</div>`;
        return;
      }
      const cacheKey = `${this.state.searchType}:${query.trim()}`;
      if (this.searchCache[cacheKey]) {
        this.state.currentData = this.searchCache[cacheKey];
        this.renderSearchResults(this.searchCache[cacheKey]);
        return;
      }
      this.renderSkeleton("search");
      this.searchTimeout = setTimeout(() => this.performSearch(query.trim()), 400);
    },

    async performSearch(query) {
      const container = document.getElementById("qobuz-content-area");
      const cacheKey  = `${this.state.searchType}:${query}`;

      if (this.searchCache[cacheKey]) {
        console.log(`[QobuzSearch] Cache hit for "${cacheKey}"`);
        this.state.currentData = this.searchCache[cacheKey];
        this.renderSearchResults(this.searchCache[cacheKey]);
        return;
      }

      // ── Artist tab: use buildArtistData to search + filter, then extract
      //    a deduplicated list of matching artists to show as cards ────────────
      if (this.state.searchType === "artist") {
        try {
          const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
          const res = await (this.api.fetch
            ? this.api.fetch(url, { headers: JUMO_HEADERS })
            : fetch(url, { headers: JUMO_HEADERS }));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();

          // Deduplicate artists from track results — each track has a performer object
          const seenIds = new Set();
          const artists = [];
          for (const t of (data.tracks?.items || [])) {
            const a = t.performer || t.artist;
            if (a?.id && !seenIds.has(a.id)) {
              seenIds.add(a.id);
              artists.push({ id: String(a.id), name: a.name || "Unknown Artist" });
            }
          }
          // Also pull artists from album results
          for (const a of (data.albums?.items || [])) {
            if (a.artist?.id && !seenIds.has(a.artist.id)) {
              seenIds.add(a.artist.id);
              artists.push({ id: String(a.artist.id), name: a.artist.name || "Unknown Artist" });
            }
          }

          // Filter to artists whose name contains the query (case-insensitive)
          // — looser than the artist page filter so partial names still surface
          const queryLower = query.toLowerCase();
          const filtered = artists.filter(a => a.name.toLowerCase().includes(queryLower));

          console.log(`[QobuzSearch] Artist tab "${query}" → ${filtered.length} artists`);

          if (!filtered.length) {
            container.innerHTML = `<div class="text-center">No artists found</div>`;
            return;
          }

          this.searchCache[cacheKey] = filtered;
          this.state.currentData = filtered;
          this.renderSearchResults(filtered);
        } catch (err) {
          console.error("[QobuzSearch] Artist tab search error:", err);
          container.innerHTML = `<div class="text-center" style="color:#f55">Error: ${err.message}</div>`;
        }
        return;
      }

      try {
        let results = null;

        // ── 1. jumo-dl (tracks + albums, no artist search) 
        if (this.state.searchType !== "artist") {
          try {
            const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
            const res = await (this.api.fetch
              ? this.api.fetch(url, { headers: JUMO_HEADERS })
              : fetch(url, { headers: JUMO_HEADERS }));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();

            // RAW RESPONSE LOGGING 
            if (DEBUG) {
              console.groupCollapsed(`[QobuzSearch] jumo-dl raw search response — "${query}"`);
              console.log("Full response object:", data);
              console.log("tracks.items count:", data.tracks?.items?.length ?? 0);
              console.log("albums.items count:", data.albums?.items?.length ?? 0);
              if (data.tracks?.items?.length) {
                console.groupCollapsed("First track object (raw):");
                console.log(data.tracks.items[0]);
                console.groupEnd();
                console.log("All track objects (raw):", data.tracks.items);
              }
              if (data.albums?.items?.length) {
                console.groupCollapsed("First album object (raw):");
                console.log(data.albums.items[0]);
                console.groupEnd();
                console.log("All album objects (raw):", data.albums.items);
              }
              console.groupEnd();
            }
            // ── END LOGGING 

            const trackItems = data.tracks?.items || [];
            if (trackItems.length) {
              this.searchCache[`track:${query}`] = trackItems.map(t => ({
                id:           String(t.id),
                title:        t.title + (t.version ? ` (${t.version})` : ""),
                artist:       t.performer?.name || t.artist?.name || "Unknown Artist",
                artistId:     t.performer?.id   || t.artist?.id   || null,
                artistSlug:   t.album?.artist?.slug || null,
                albumTitle:   t.album?.title    || "",
                albumId:      t.album?.id       ? String(t.album.id) : null,
                duration:     t.duration        || 0,
                cover:        t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
                bitDepth:     t.maximum_bit_depth      || null,
                sampleRate:   t.maximum_sampling_rate  || null,
                audioQuality: t.maximum_bit_depth
                  ? `${t.maximum_bit_depth}bit / ${t.maximum_sampling_rate}kHz`
                  : (t.maximum_technical_specifications || ""),
                isHiRes:          !!(t.hires_streamable),
                trackNumber:      t.track_number  || null,
                discNumber:       t.media_number  || null,
                parental_warning: !!(t.parental_warning),
                _source:      "jumo"
              }));
            }

            const albumItems = data.albums?.items || [];
            if (albumItems.length) {
              this.searchCache[`album:${query}`] = albumItems.map(a => ({
                id:          String(a.id),
                title:       a.title,
                artist:      a.artist?.name || "Unknown Artist",
                cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
                isHiRes:     !!(a.hires_streamable),
                tracksCount: a.tracks_count || null,
                _source:     "jumo"
              }));
            }

            results = this.searchCache[`${this.state.searchType}:${query}`] || null;
            if (results) console.log(`[QobuzSearch] Search OK via jumo-dl (${results.length} results)`);
          } catch (e) {
            console.warn("[QobuzSearch] jumo-dl search failed:", e.message);
            results = null;
          }
        }

        // ── 2. YAMS (tracks only, filter to qobuz platform) 
        if (!results && this.state.searchType === "track") {
          try {
            const url = `${YAMS_SEARCH_BASE}?query=${encodeURIComponent(query)}`;
            const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data        = await res.json();
            const qobuzTracks = (data.tracks || []).filter(t => t.platform === "qobuz");
            if (qobuzTracks.length) {
              results = qobuzTracks.map(t => ({
                id:           `qobuz:${t.id}`,
                _rawId:       String(t.id),
                title:        t.title,
                artist:       t.artist || "Unknown Artist",
                artistId:     null,
                albumTitle:   t.album  || "",
                duration:     t.duration || 0,
                cover:        t.cover  || "",
                bitDepth:     null,
                sampleRate:   null,
                audioQuality: "",
                isHiRes:      false,
                _source:      "yams"
              }));
              console.log(`[QobuzSearch] Search OK via YAMS (${results.length} results)`);
            }
          } catch (e) {
            console.warn("[QobuzSearch] YAMS search failed:", e.message);
          }
        }

        // ── 3. dabmusic (last resort, currently 403) 
        if (!results) {
          try {
            const url = `${DAB_BASE}/search?q=${encodeURIComponent(query)}&offset=0&type=${this.state.searchType}`;
            const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            let items = [];
            if (this.state.searchType === "track")       items = data.tracks  || [];
            else if (this.state.searchType === "album")  items = data.albums  || [];
            else if (this.state.searchType === "artist") items = data.artists || [];
            if (!items.length && Array.isArray(data)) items = data;
            if (items.length) {
              results = items;
              console.log(`[QobuzSearch] Search OK via dabmusic (${results.length} results)`);
            }
          } catch (e) {
            console.warn("[QobuzSearch] dabmusic search failed:", e.message);
          }
        }

        if (!results?.length) {
          container.innerHTML = `<div class="text-center">No results found</div>`;
          return;
        }

        if (!this.searchCache[cacheKey]) {
          this.searchCache[cacheKey] = results;
        }
        this.state.currentData = results;
        this.renderSearchResults(results);
      } catch (err) {
        console.error("[QobuzSearch] Search error:", err);
        container.innerHTML = `<div class="text-center" style="color:#f55">Error: ${err.message}</div>`;
      }
    },

    async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await (this.api.fetch
          ? this.api.fetch(url, { ...options, signal: controller.signal })
          : fetch(url, { ...options, signal: controller.signal }));
      } finally {
        clearTimeout(timer);
      }
    },

    async fetchAlbumDetails(albumId) {
      this.renderSkeleton("album");
      try {
        const url = `${JUMO_BASE}/album?album_id=${albumId}&region=NZ`;
        const res = await this.fetchWithTimeout(url, { headers: JUMO_HEADERS }, 10000);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // RAW RESPONSE LOGGING 
        if (DEBUG) {
          console.groupCollapsed(`[QobuzSearch] jumo-dl raw album response — ID: ${albumId}`);
          console.log("Full album object:", data);
          console.log("Title:", data.title);
          console.log("Artist:", data.artist?.name);
          console.log("Track count (reported by API):", data.tracks_count);
          console.log("Track count (actually returned):", data.tracks?.items?.length ?? 0);
          console.log("Hi-Res streamable:", data.hires_streamable);
          console.log("Bit depth:", data.maximum_bit_depth);
          console.log("Sample rate:", data.maximum_sampling_rate);
          if (data.tracks?.items?.length) {
            console.groupCollapsed("First track object (raw):");
            console.log(data.tracks.items[0]);
            console.groupEnd();
            console.log("All track objects (raw):", data.tracks.items);
          }
          console.groupEnd();
        }
        // END LOGGING 

        const trackItems         = data.tracks?.items || [];
        const expectedTrackCount = data.tracks_count  || null;

        return {
          id:                 String(data.id || albumId),
          title:              data.title        || "Unknown Album",
          artist:             data.artist?.name || "Unknown Artist",
          artistId:           data.artist?.id   || null,
          cover:              data.image?.large || data.image?.small || data.image?.thumbnail || "",
          releaseDate:        data.release_date_original || data.released_at || null,
          releaseType:        data.release_type  || null,
          isHiRes:            !!(data.hires_streamable),
          bitDepth:           data.maximum_bit_depth     || null,
          sampleRate:         data.maximum_sampling_rate || null,
          genre:              data.genre?.name  || null,
          label:              data.label?.name  || null,
          description:        data.description  || null,
          totalDuration:      data.duration     || null,
          expectedTrackCount: expectedTrackCount,
          tracks: trackItems.map(t => ({
            id:          String(t.id),
            title:       t.title + (t.version ? ` (${t.version})` : ""),
            artist:      data.artist?.name || "Unknown Artist",
            artistId:    data.artist?.id   || null,
            artistSlug:  data.artist?.slug || null,
            albumTitle:  data.title        || "",
            albumId:     String(data.id || ""),
            duration:    t.duration        || 0,
            cover:       data.image?.large || data.image?.small || data.image?.thumbnail || "",
            trackNumber: t.track_number    || null,
            discNumber:  t.media_number    || null,
            bitDepth:    t.maximum_bit_depth     || data.maximum_bit_depth     || null,
            sampleRate:  t.maximum_sampling_rate || data.maximum_sampling_rate || null,
            isHiRes:     !!(t.hires_streamable  ?? data.hires_streamable),
            parental_warning: !!(t.parental_warning),
          }))
        };
      } catch (err) {
        const msg = err.name === "AbortError"
          ? "Album details timed out"
          : "Error loading album";
        this.showToast(msg, true);
        console.error("[QobuzSearch] fetchAlbumDetails:", err);
        return null;
      }
    },

    async buildArtistData(artistId, artistName) {
      // Fire a jumo-dl search using the artist name as the query, then filter
      // both tracks and albums down to exact artist name matches.
      const query = artistName.trim();
      const cacheKey = `artist:${query}`;

      if (this.searchCache[cacheKey]) {
        console.log(`[QobuzSearch] Artist cache hit for "${query}"`);
        return this.searchCache[cacheKey];
      }

      try {
        const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=50&region=NZ`;
        const res = await (this.api.fetch
          ? this.api.fetch(url, { headers: JUMO_HEADERS })
          : fetch(url, { headers: JUMO_HEADERS }));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const nameLower = artistName.toLowerCase();

        const tracks = (data.tracks?.items || [])
          .filter(t => (t.performer?.name || t.artist?.name || "").toLowerCase() === nameLower)
          .map(t => ({
            id:           String(t.id),
            title:        t.title + (t.version ? ` (${t.version})` : ""),
            artist:       t.performer?.name || t.artist?.name || artistName,
            artistId:     t.performer?.id   || t.artist?.id   || artistId,
            artistSlug:   t.album?.artist?.slug || null,
            albumTitle:   t.album?.title    || "",
            albumId:      t.album?.id       ? String(t.album.id) : null,
            duration:     t.duration        || 0,
            cover:        t.album?.image?.large || t.album?.image?.small || t.album?.image?.thumbnail || "",
            bitDepth:     t.maximum_bit_depth      || null,
            sampleRate:   t.maximum_sampling_rate  || null,
            audioQuality: t.maximum_bit_depth
              ? `${t.maximum_bit_depth}bit / ${t.maximum_sampling_rate}kHz`
              : (t.maximum_technical_specifications || ""),
            isHiRes:          !!(t.hires_streamable),
            trackNumber:      t.track_number  || null,
            discNumber:       t.media_number  || null,
            parental_warning: !!(t.parental_warning),
            _source: "jumo"
          }));

        const albums = (data.albums?.items || [])
          .filter(a => (a.artist?.name || "").toLowerCase() === nameLower)
          .map(a => ({
            id:          String(a.id),
            title:       a.title,
            artist:      a.artist?.name || artistName,
            cover:       a.image?.large || a.image?.small || a.image?.thumbnail || "",
            isHiRes:     !!(a.hires_streamable),
            tracksCount: a.tracks_count || null,
            _source:     "jumo"
          }));

        console.log(`[QobuzSearch] Artist search "${query}" → ${tracks.length} tracks, ${albums.length} albums after filter`);

        // Pull catalog-level artist metadata from the first matched item
        const firstTrack = (data.tracks?.items || []).find(t =>
          (t.performer?.name || "").toLowerCase() === nameLower ||
          (t.album?.artist?.name || "").toLowerCase() === nameLower
        );
        const firstAlbum = (data.albums?.items || []).find(a =>
          (a.artist?.name || "").toLowerCase() === nameLower
        );
        const artistMeta  = firstTrack?.album?.artist || firstAlbum?.artist || {};
        const albumsCount = artistMeta.albums_count || null;  // total on Qobuz catalog
        const artistSlug  = artistMeta.slug || null;          // e.g. "queen" — URL key

        const result = { artistId, artistName, tracks, albums, albumsCount, artistSlug };
        this.searchCache[cacheKey] = result;
        return result;

      } catch (err) {
        console.warn("[QobuzSearch] Artist search failed:", err.message);
        // Fall back to whatever is already in cache from prior searches
        return this._buildArtistFromCache(artistId, artistName);
      }
    },

    // Fallback: use existing cache entries if the live search fails
    _buildArtistFromCache(artistId, artistName) {
      const nameLower = artistName?.toLowerCase();
      const seenTrackIds = new Set();
      const seenAlbumIds = new Set();
      const tracks = [];
      const albums = [];

      for (const [key, items] of Object.entries(this.searchCache)) {
        if (!Array.isArray(items)) continue;
        if (key.startsWith("track:")) {
          for (const t of items) {
            if (String(t.artistId) === String(artistId) && !seenTrackIds.has(t.id)) {
              seenTrackIds.add(t.id);
              tracks.push(t);
            }
          }
        }
        if (key.startsWith("album:")) {
          for (const a of items) {
            if (a.artist?.toLowerCase() === nameLower && !seenAlbumIds.has(a.id)) {
              seenAlbumIds.add(a.id);
              albums.push(a);
            }
          }
        }
      }

      return { artistId, artistName, tracks, albums, albumsCount: null, artistSlug: null };
    },

    decodeManifest(data) {
      try {
        const { manifestMimeType, manifest: manifestB64 } = data;
        const manifestStr = atob(manifestB64);

        if (manifestMimeType === "application/json" || !manifestMimeType) {
          // Direct URL in JSON wrapper
          const parsed = JSON.parse(manifestStr);
          if (parsed.url) return parsed.url;
          if (parsed.urls?.[0]) return parsed.urls[0];
        } else if (manifestMimeType === "application/dash+xml") {
          console.log("[QobuzSearch] MPD manifest — returning as blob URL for dash.js");
          const blob = new Blob([manifestStr], { type: "application/dash+xml" });
          return URL.createObjectURL(blob);
        }
        return null;
      } catch (err) {
        console.error("[QobuzSearch] Manifest decode error:", err);
        return null;
      }
    },

    async fetchStream(trackId) {
      const rawId = String(trackId).startsWith("qobuz:")
        ? String(trackId).split(":")[1]
        : String(trackId);

      const selectedQuality = document.getElementById("qobuz-quality-select")?.value || DEFAULT_QUALITY;

      // Quality fallback order — try all providers per tier before dropping quality
      const QUALITY_FALLBACKS = {
        "Studio Quality": ["Hi-Res", "CD", "320kbps"],
        "Hi-Res":         ["CD", "320kbps"],
        "CD":             ["Hi-Res", "320kbps"],
        "320kbps":        ["CD", "Hi-Res"],
      };
      const qualitiesToTry = [selectedQuality, ...(QUALITY_FALLBACKS[selectedQuality] || [])];

      for (const quality of qualitiesToTry) {
        // ── 1. Paxsenix 
        try {
          const paxAuth = getPaxAuth();
          if (!paxAuth) {
            // Show actionable toast and skip Paxsenix
            this.showToast("⚙️ Add your Paxsenix API key in Settings to enable streaming", true, true);
            throw new Error("No Paxsenix API key configured");
          }
          const qobuzUrl = encodeURIComponent(`https://open.qobuz.com/track/${rawId}`);
          const url = `${PAX_BASE}?url=${qobuzUrl}&quality=${encodeURIComponent(quality)}`;
          const res = await (this.api.fetch
            ? this.api.fetch(url, { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } })
            : fetch(url,          { headers: { "Authorization": paxAuth, "Content-Type": "application/json" } }));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();

          // Handle both direct URL and manifest responses
          let streamUrl = data.directUrl || data.data?.directUrl || null;
          if (!streamUrl && data.manifest) streamUrl = this.decodeManifest(data);

          if (!streamUrl) throw new Error("No stream URL in Paxsenix response");
          console.log(`[QobuzSearch] Stream OK via Paxsenix @ ${quality}`);
          if (streamUrl?.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(streamUrl), 5000);
          return { url: streamUrl, quality, source: "paxsenix" };
        } catch (e) {
          console.warn(`[QobuzSearch] Paxsenix failed @ ${quality}:`, e.message);
        }

        // ── 2. dabmusic 
        try {
          const url = `${DAB_BASE}/stream?trackId=${rawId}&quality=${encodeURIComponent(quality)}`;
          const res = await (this.api.fetch ? this.api.fetch(url) : fetch(url));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();

          let streamUrl = data.url || null;
          if (!streamUrl && data.manifest) streamUrl = this.decodeManifest(data);

          if (!streamUrl) throw new Error("No stream URL in dabmusic response");
          console.log(`[QobuzSearch] Stream OK via dabmusic @ ${quality}`);
          if (streamUrl?.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(streamUrl), 5000);
          return { url: streamUrl, quality, source: "dabmusic" };
        } catch (e) {
          console.warn(`[QobuzSearch] dabmusic failed @ ${quality}:`, e.message);
        }

        console.warn(`[QobuzSearch] All providers failed @ ${quality}, trying next tier...`);
      }

      throw new Error("[QobuzSearch] All providers and quality tiers exhausted");
    },

    // ═══════════════════════════════════════════════════════════════════
    // RENDERING
    // ═══════════════════════════════════════════════════════════════════

    renderSkeleton(type) {
      const container = document.getElementById("qobuz-content-area");
      if (type === 'search' && this.state.searchType === 'track') {
        container.innerHTML = Array(6).fill('<div class="qobux-skeleton-row"></div>').join('');
      } else if (type === 'search' || type === 'artist') {
        container.innerHTML = `<div style="padding:20px; display:grid; grid-template-columns:repeat(auto-fill, minmax(160px,1fr)); gap:20px;">` +
          Array(8).fill('<div class="qobux-skeleton-card"></div>').join('') + '</div>';
      } else if (type === 'album') {
        container.innerHTML = `
           <div style="padding:24px; display:flex; gap:24px;">
             <div class="qobux-skeleton" style="width:160px; height:160px; flex-shrink:0;"></div>
             <div style="flex:1; display:flex; flex-direction:column; justify-content:center; gap:12px;">
                <div class="qobux-skeleton" style="width:60%; height:24px;"></div>
                <div class="qobux-skeleton" style="width:40%; height:16px;"></div>
             </div>
           </div>
           <div style="padding:0 16px 24px;">
             ${Array(5).fill('<div class="qobux-skeleton-row"></div>').join('')}
           </div>
         `;
      }
    },

    render() {
      if (this.state.view === "search") {
        if (this.state.currentData)
          this.renderSearchResults(this.state.currentData);
      } else if (this.state.view === 'album') {
        this.renderAlbumView(this.state.currentData);
      } else if (this.state.view === 'artist') {
        this.renderArtistView(this.state.currentData);
      }
    },

    renderSearchResults(results) {
      const container = document.getElementById("qobuz-content-area");
      if (!results?.length) { container.innerHTML = `<div class="text-center">No results found</div>`; return; }
      if (this.state.searchType === 'track') {
        container.innerHTML = `<div class="qobuz-track-list">${results.map(t => this.renderTrackItem(t, false)).join('')}</div>`;
        this.attachTrackListeners(container, results);
      } else if (this.state.searchType === "artist") {
        container.innerHTML = `<div class="qobuz-grid-list">${results.map(a => this.renderArtistCard(a)).join("")}</div>`;
        this.attachArtistCardListeners(container, results);
      } else {
        container.innerHTML = `<div class="qobuz-grid-list">${results.map(item => this.renderCard(item, true)).join('')}</div>`;
        this.attachCardListeners(container, results, true);
      }
    },

    renderAlbumView(album) {
      const container = document.getElementById("qobuz-content-area");
      if (!album) {
        container.innerHTML = `<div class="qobuz-unavailable"><div class="qobuz-unavailable-icon">⚠️</div>Album details unavailable</div>`;
        return;
      }

      const badge = album.isHiRes ? '<span class="qobuz-badge">Hi-Res</span>' : "";
      const qualityInfo = album.bitDepth
        ? `${album.bitDepth}bit / ${album.sampleRate}kHz`
        : "";

      const releaseTypeLabel = album.releaseType
        ? album.releaseType.charAt(0).toUpperCase() + album.releaseType.slice(1).toLowerCase()
        : "Album";

      const totalDurationFormatted = album.totalDuration
        ? this.formatDuration(album.totalDuration)
        : null;

      const missingTracks = album.expectedTrackCount && album.tracks.length < album.expectedTrackCount
        ? album.expectedTrackCount - album.tracks.length
        : 0;

      container.innerHTML = `
        <div class="qobuz-hero">
          <img src="${this.escapeHtml(album.cover)}" class="qobuz-hero-cover" onerror="this.src='https://picsum.photos/200'">
          <div class="qobuz-hero-info">
            <div class="qobuz-hero-type">${releaseTypeLabel} ${badge}</div>
            <div class="qobuz-hero-title">${this.escapeHtml(album.title)}</div>
            <div class="qobuz-hero-meta">
              <span class="qobuz-clickable-artist" data-artist-id="${album.artistId || ''}">${this.escapeHtml(album.artist)}</span> 
              • <span>${album.releaseDate ? album.releaseDate.split('-')[0] : '----'}</span> 
              • <span>${album.tracks.length} songs</span>
              ${totalDurationFormatted ? `• <span>${totalDurationFormatted}</span>` : ""}
              ${qualityInfo ? `• <span>${qualityInfo}</span>` : ""}
              ${album.genre  ? `• <span>${this.escapeHtml(album.genre)}</span>` : ""}
              ${album.label  ? `• <span>${this.escapeHtml(album.label)}</span>` : ""}
            </div>
            <button id="qobuz-save-all-btn" class="qobuz-save-all-btn">
               ${ICONS.download} Save All Tracks
            </button>
          </div>
        </div>
        <div class="qobuz-track-list">${album.tracks.map(t => this.renderTrackItem(t, true)).join("")}</div>
        ${missingTracks > 0 ? `
          <div class="qobuz-missing-warning">
            ⚠️ ${missingTracks} track${missingTracks > 1 ? "s" : ""} may be missing — Qobuz reports ${album.expectedTrackCount} total but only ${album.tracks.length} were returned.
          </div>` : ""}
      `;

      // Attach Listeners
      const heroArtist = container.querySelector('.qobuz-hero .qobuz-clickable-artist');
      if (heroArtist) {
        heroArtist.onclick = () => {
          if (album.artistId) this.loadArtistPage(album.artistId, album.artist);
        };
      }

      container.querySelector("#qobuz-save-all-btn").onclick = () => this.saveAllTracks(album.tracks, album);
      this.attachTrackListeners(container, album.tracks);
    },

    renderArtistView(data) {
      const container = document.getElementById("qobuz-content-area");

      const { artistName, tracks = [], albums = [], albumsCount = null } = data || {};

      // Build initials avatar from artist name
      const initials = (artistName || "?")
        .split(" ").slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("");

      // Stats line
      const statParts = [];
      if (albums.length) statParts.push(`${albums.length} album${albums.length !== 1 ? "s" : ""} in results`);
      if (tracks.length) statParts.push(`${tracks.length} track${tracks.length !== 1 ? "s" : ""} in results`);

      const hiResCount = tracks.filter(t => t.isHiRes).length;
      const qualityNote = hiResCount > 0
        ? `${hiResCount} Hi-Res track${hiResCount !== 1 ? "s" : ""} available`
        : "";

      container.innerHTML = `
        <div class="qobuz-hero">
          <div class="qobuz-artist-avatar" aria-label="${this.escapeHtml(artistName || "Artist")}">${this.escapeHtml(initials)}</div>
          <div class="qobuz-hero-info">
            <div class="qobuz-hero-type">Artist</div>
            <div class="qobuz-hero-title">${this.escapeHtml(artistName || "Unknown Artist")}</div>
            <div class="qobuz-hero-meta">
              ${statParts.map(p => `<span>${p}</span>`).join(" • ")}
              ${qualityNote ? `<span style="color:var(--accent-primary,#1a62b9);">${qualityNote}</span>` : ""}
            </div>
            ${albumsCount ? `<div style="font-size:12px; color:var(--text-subdued,#666); margin-top:4px;">${albumsCount} albums on Qobuz</div>` : ""}
            <div style="font-size:11px; color:var(--text-subdued,#555); margin-top:10px;">
              Showing results from your current search session
            </div>
            ${tracks.length ? `
              <button id="qobuz-artist-save-all-btn" class="qobuz-save-all-btn">
                ${ICONS.download} Save All ${tracks.length} Tracks
              </button>
            ` : ""}
          </div>
        </div>

        ${tracks.length ? `
          <div class="qobuz-section-header">Known Tracks</div>
          <div class="qobuz-track-list" id="qobuz-artist-tracks">
            ${tracks.map(t => this.renderTrackItem(t, false)).join("")}
          </div>
        ` : ""}

        ${albums.length ? `
          <div class="qobuz-section-header">Known Albums</div>
          <div class="qobuz-grid-list" id="qobuz-artist-albums">
            ${albums.map(a => this.renderCard(a, true)).join("")}
          </div>
        ` : ""}

        ${!tracks.length && !albums.length ? `
          <div class="qobuz-unavailable">
            <div class="qobuz-unavailable-icon">🎤</div>
            <div>No data found for this artist in the current search session.</div>
            <div style="margin-top:8px; font-size:12px;">Search for their name or album title to populate this page.</div>
          </div>
        ` : ""}
      `;

      const trackList = container.querySelector("#qobuz-artist-tracks");
      if (trackList) this.attachTrackListeners(trackList, tracks);

      const albumGrid = container.querySelector("#qobuz-artist-albums");
      if (albumGrid) this.attachCardListeners(albumGrid, albums, true);

      const artistSaveAllBtn = container.querySelector("#qobuz-artist-save-all-btn");
      if (artistSaveAllBtn) artistSaveAllBtn.onclick = () => this.saveAllTracks(tracks);
    },

    renderTrackItem(track, isCompact = false) {
      
      const isPlaying = this.isPlaying === String(track.id);
      const isSaved   = this.libraryTracks.has(String(track.id));
      const coverUrl  = track.cover || track.albumCover || "";

      const qualityLabel = track.bitDepth && track.sampleRate
        ? `${track.bitDepth}bit / ${track.sampleRate}kHz`
        : (track.audioQuality || "");

      const hiresBadge = track.isHiRes
        ? `<span class="qobuz-badge" style="font-size:9px; padding:1px 5px; flex-shrink:0;">Hi-Res</span>`
        : "";

      const explicitBadge = track.parental_warning
        ? `<span class="qobuz-explicit-badge">E</span>`
        : "";

      return `
        <div class="qobuz-track-item ${isPlaying ? 'playing' : ''}" data-id="${track.id}">
          <div class="qobuz-track-cover-wrapper">
            <img src="${this.escapeHtml(coverUrl)}" class="qobuz-track-cover" loading="lazy" onerror="this.style.display='none'">
            <div class="qobuz-play-overlay">${isPlaying ? ICONS.play : ''}</div>
          </div>
          <div style="min-width:0;">
            <div class="qobuz-track-title">
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;">${this.escapeHtml(track.title)}</span>
              ${hiresBadge}
              ${explicitBadge}
            </div>
            ${!isCompact
              ? `<div class="qobuz-track-artist">
                  <span class="qobuz-clickable-artist" data-artist-id="${track.artistId || ""}">${this.escapeHtml(track.artist)}</span>
                  ${track.albumTitle ? `<span style="color:var(--text-subdued,#666); font-size:16px; margin:0 4px; line-height:1;">·</span><span style="color:var(--text-secondary,#888); font-size:12px;">${this.escapeHtml(track.albumTitle)}</span>` : ""}
                  ${qualityLabel ? `<span style="color:var(--text-subdued,#666); font-size:16px; margin:0 4px; line-height:1;">·</span><span style="color:var(--text-subdued,#555); font-size:11px;">${this.escapeHtml(qualityLabel)}</span>` : ""}
                </div>`
              : (qualityLabel ? `<div style="font-size:11px; color:var(--text-subdued,#555); margin-top:2px;">${this.escapeHtml(qualityLabel)}</div>` : "")}
          </div>
          ${!isCompact ? `<div class="qobuz-track-time">${this.formatDuration(track.duration)}</div>` : ""}
          <div class="qobuz-track-actions">
             <button class="qobuz-save-btn-mini ${isSaved ? 'saved' : ''}" title="${isSaved ? 'Saved to Library' : 'Add to Library'}">
                ${isSaved ? ICONS.heart : ICONS.heartOutline}
             </button>
          </div>
        </div>
      `;
    },

    renderCard(item, isAlbum) {
      const imgUrl = isAlbum
        ? (item.cover || "")
        : (item.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.name || "")}&background=333&color=fff`);
      const title      = isAlbum ? item.title : item.name;
      const artistText = isAlbum ? item.artist : (item.albumsCount || "Artist");
      const trackCount = isAlbum && item.tracksCount ? `${item.tracksCount} tracks` : null;

      const hiresBadge = (isAlbum && item.isHiRes)
        ? `<span class="qobuz-badge" style="font-size:9px; padding:1px 5px; flex-shrink:0;">Hi-Res</span>`
        : "";

      return `
        <div class="qobuz-card" data-id="${item.id}">
          <img src="${this.escapeHtml(imgUrl)}" class="qobuz-card-img" loading="lazy">
          <div class="qobuz-card-title">${this.escapeHtml(title)}</div>
          <div class="qobuz-card-sub">
            <span class="qobuz-card-sub-text">${this.escapeHtml(artistText)}</span>
            ${trackCount ? `<span class="qobuz-card-sub-count">• ${trackCount}</span>` : ""}
            ${hiresBadge}
          </div>
        </div>
      `;
    },

    renderArtistCard(artist) {
      const initials = (artist.name || "?")
        .split(" ").slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("");
      return `
        <div class="qobuz-card qobuz-artist-card" data-id="${artist.id}">
          <div class="qobuz-artist-card-avatar">${this.escapeHtml(initials)}</div>
          <div class="qobuz-card-title">${this.escapeHtml(artist.name)}</div>
          <div class="qobuz-card-sub"><span class="qobuz-card-sub-text">Artist</span></div>
        </div>
      `;
    },

    attachArtistCardListeners(container, artists) {
      container.querySelectorAll(".qobuz-artist-card").forEach((el) => {
        el.onclick = () => {
          const artist = artists.find(a => String(a.id) === String(el.dataset.id));
          if (artist) this.loadArtistPage(artist.id, artist.name);
        };
      });
    },

    attachTrackListeners(container, tracks) {
      container.querySelectorAll('.qobuz-track-item').forEach((el) => {
        el.onclick = (e) => {
          const artistClick = e.target.closest('.qobuz-clickable-artist');
          if (artistClick) {
            const artistId = artistClick.dataset.artistId;
            const artistName = artistClick.textContent;
            if (artistId) this.loadArtistPage(artistId, artistName);
            return;
          }
          const track = tracks.find(t => String(t.id) === String(el.dataset.id));
          if (!track) return;
          const saveBtn = e.target.closest('.qobuz-save-btn-mini');
          if (saveBtn) { this.saveTrack(track, saveBtn); return; }
          this.playTrack(track);
        };
      });
    },

    attachCardListeners(container, items, isAlbum) {
      container.querySelectorAll(".qobuz-card").forEach((el) => {
        el.onclick = () => {
          const item = items.find(i => String(i.id) === String(el.dataset.id));
          if (!item) return;
          if (isAlbum) this.loadAlbumPage(item.id, item.title);
          else this.loadArtistPage(item.id, item.name);
        };
      });
    },

    async loadAlbumPage(id, title) {
      this.showToast("Loading Album...");
      const albumData = await this.fetchAlbumDetails(id);
      this.navigateTo("album", albumData, albumData?.title || title);
    },

    async loadArtistPage(id, name) {
      this.renderSkeleton("artist");
      const artistData = await this.buildArtistData(id, name);
      this.navigateTo("artist", artistData, name);
    },

    // ═══════════════════════════════════════════════════════════════════
    // ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    async playTrack(track) {
      try {
        const streamData = await this.fetchStream(track.id);
        if (!streamData?.url) throw new Error("No stream URL");

        this.isPlaying = String(track.id);
        document.querySelectorAll(".qobuz-track-item").forEach(el => {
          el.classList.toggle("playing", el.dataset.id === String(track.id));
        });

        const qualityLabel = track.bitDepth && track.sampleRate
          ? `${track.bitDepth}bit / ${track.sampleRate}kHz`
          : (track.audioQuality || streamData.quality || DEFAULT_QUALITY);

        if (this.api?.player?.setTrack) {
          this.api.player.setTrack({
            id:          track.id,
            path:        streamData.url,
            source_type: SOURCE_TYPE,
            title:       track.title,
            artist:      track.artist,
            album:       track.albumTitle  || null,
            duration:    track.duration    || null,
            cover_url:   track.cover || track.albumCover || null,
            format:      qualityLabel,
          });
        }

        this.updateNowPlaying(track);
        this.showToast(`▶ ${track.title} [${qualityLabel}]`);
      } catch (err) {
        console.error("[QobuzSearch] Playback error:", err);
        this.showToast("Playback Error", true);
      }
    },

    async saveTrack(track, btn) {
      try {
        const externalId = String(track.id).startsWith("qobuz:")
          ? String(track.id).split(":")[1]
          : String(track.id);
        if (this.libraryTracks.has(externalId)) {
          this.showToast("Already in library");
          return;
        }

        if (this.api?.library?.addExternalTrack) {
          await this.api.library.addExternalTrack({
            title:        track.title,
            artist:       track.artist,
            album:        track.albumTitle  || null,
            duration:     track.duration    || null,
            cover_url:    track.cover || track.albumCover || null,
            track_number: track.trackNumber || null,
            disc_number:  track.discNumber  || null,
            format:       (track.bitDepth && track.sampleRate)
              ? `${track.bitDepth}bit/${track.sampleRate}kHz`
              : (track.isHiRes ? "Hi-Res" : "CD"),
            bitrate:      null,
            source_type:  SOURCE_TYPE,
            external_id:  externalId
          });
          this.libraryTracks.add(externalId);
          if (btn) { btn.classList.add("saved"); btn.innerHTML = ICONS.heart; btn.title = "Saved to Library"; }
          this.showToast(`Saved: ${track.title}`);
          this.hasNewChanges = true;
        }
      } catch (e) {
        console.error("[QobuzSearch] saveTrack error:", e);
        this.showToast("Error saving track", true);
      }
    },

    async saveAllTracks(tracks, albumData = null) {
      if (!tracks?.length) { this.showToast("No tracks to save", true); return; }

      const progressEl   = document.getElementById("qobuz-save-progress");
      const progressBar  = progressEl?.querySelector(".qobuz-progress-bar-inner");
      const progressText = progressEl?.querySelector(".qobuz-progress-text");
      if (progressEl) progressEl.classList.remove("hidden");

      let savedCount = 0, skippedCount = 0, errorCount = 0;

      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];

        // Update progress bar
        const pct = ((i + 1) / tracks.length) * 100;
        if (progressBar)  progressBar.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `Saving ${i + 1} of ${tracks.length} tracks...`;

        const externalId = String(track.id).startsWith("qobuz:")
          ? String(track.id).split(":")[1]
          : String(track.id);

        if (this.libraryTracks.has(externalId)) { skippedCount++; continue; }

        try {
          if (this.api?.library?.addExternalTrack) {
            await this.api.library.addExternalTrack({
              title:        track.title,
              artist:       track.artist || albumData?.artist || null,
              album:        track.albumTitle || albumData?.title || null,
              duration:     track.duration   || null,
              cover_url:    track.cover || albumData?.cover || null,
              track_number: track.trackNumber || null,
              disc_number:  track.discNumber  || null,
              format:       (track.bitDepth && track.sampleRate)
                ? `${track.bitDepth}bit/${track.sampleRate}kHz`
                : (track.isHiRes ? "Hi-Res" : "CD"),
              bitrate:      null,
              source_type:  SOURCE_TYPE,
              external_id:  externalId,
            });
            this.libraryTracks.add(externalId);
            savedCount++;

            // Update heart icon if row is visible
            const row = document.querySelector(`.qobuz-track-item[data-id="${track.id}"]`);
            if (row) {
              const btn = row.querySelector(".qobuz-save-btn-mini");
              if (btn) { btn.classList.add("saved"); btn.innerHTML = ICONS.heart; btn.title = "Saved to Library"; }
            }
          }
        } catch (e) {
          console.error("[QobuzSearch] Failed to save track", track.id, e);
          errorCount++;
        }

        await new Promise(r => setTimeout(r, 50));
      }

      if (progressEl) progressEl.classList.add("hidden");
      if (progressBar) progressBar.style.width = "0%";

      if (errorCount === 0) {
        this.showToast(skippedCount > 0
          ? `✓ Saved ${savedCount} tracks (${skippedCount} already in library)`
          : `✓ Saved all ${savedCount} tracks to library`);
      } else {
        this.showToast(`Saved ${savedCount} tracks, ${errorCount} failed`, errorCount > savedCount / 2);
      }

      this.hasNewChanges = true;
      if (this.api?.library?.refresh) await this.api.library.refresh();
    },

    async searchCoverForRPC(title, artist, trackId) {
      const tag = "[QobuzSearch:searchCoverForRPC]";
      try {
        const query = `${title} ${artist}`.trim();
        console.log(`${tag} Searching cover for "${query}"`);

        const url = `${JUMO_BASE}/search?query=${encodeURIComponent(query)}&offset=0&limit=10&region=NZ`;
        const res = await (this.api.fetch
          ? this.api.fetch(url, { headers: JUMO_HEADERS })
          : fetch(url, { headers: JUMO_HEADERS }));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const items = data.tracks?.items || [];
        if (!items.length) { console.warn(`${tag} No results for "${query}"`); return null; }

        const cover = items[0].album?.image?.large
          || items[0].album?.image?.small
          || items[0].album?.image?.thumbnail
          || null;

        if (!cover) { console.warn(`${tag} First result has no cover`); return null; }

        console.log(`${tag} Cover found: ${cover}`);

        // Update database if trackId provided
        if (trackId && this.api.library?.updateTrackCoverUrl) {
          try {
            await this.api.library.updateTrackCoverUrl(trackId, cover);
            console.log(`${tag} Updated cover_url for trackId=${trackId}`);
          } catch (err) {
            console.warn(`${tag} Could not update database:`, err);
          }
        }

        return cover;
      } catch (err) {
        console.error(`${tag} Error:`, err);
        return null;
      }
    },

    updateNowPlaying(track) {
      const trackTitle  = document.querySelector(".now-playing .track-title, .track-info .title");
      const trackArtist = document.querySelector(".now-playing .track-artist, .track-info .artist");
      const albumArt    = document.querySelector(".now-playing .album-art img, .album-art img");
      if (trackTitle)  trackTitle.textContent  = track.title;
      if (trackArtist) trackArtist.textContent = track.artist || "";
      if (albumArt && (track.cover || track.albumCover)) albumArt.src = track.cover || track.albumCover;
    },

    showToast(msg, isError = false, withSettingsLink = false) {
      const toast = document.createElement("div");
      toast.style.cssText = `position:fixed; bottom:100px; left:50%; transform:translateX(-50%); background:${isError ? '#c0392b' : '#333'}; color:#fff; padding:10px 20px; border-radius:8px; z-index:10002; font-size:13px; box-shadow:0 4px 12px rgba(0,0,0,0.3); opacity:0; transition:0.3s; display:flex; align-items:center; gap:12px; white-space:nowrap;`;
      const textSpan = document.createElement("span");
      textSpan.textContent = msg;
      toast.appendChild(textSpan);
      if (withSettingsLink) {
        const link = document.createElement("button");
        link.textContent = "Open Settings";
        link.style.cssText = "background:rgba(255,255,255,0.2); border:none; border-radius:5px; color:#fff; font-size:12px; font-weight:700; padding:4px 10px; cursor:pointer; flex-shrink:0;";
        link.onclick = () => {
          toast.remove();
          document.querySelector("#qobuz-settings-panel")?.classList.add("open");
          // Also refresh key status display
          const key = getPaxKey();
          const status = document.querySelector("#qobuz-pax-key-status");
          if (status) {
            if (key) { status.className = "qobuz-api-key-status ok"; status.textContent = "✓ API key saved"; }
            else      { status.className = "qobuz-api-key-status missing"; status.textContent = "No API key saved. Streaming via Paxsenix will be unavailable."; }
          }
        };
        toast.appendChild(link);
      }
      document.body.appendChild(toast);
      requestAnimationFrame(() => toast.style.opacity = '1');
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, withSettingsLink ? 6000 : 3000);
    },

    start() { },
    stop() { this.close(); },
    destroy() {
      this.close();
      document.getElementById("qobuz-search-styles-v4")?.remove();
      document.getElementById("qobuz-search-panel")?.remove();
      document.getElementById("qobuz-search-overlay")?.remove();
      document.getElementById("qobuz-search-btn")?.remove();
      document.getElementById("qobuz-save-progress")?.remove();
    }
  };

  // Expose API for other plugins with permission
  window.QobuzSearchAPI = {
    searchCover: async (title, artist, trackId, callerPluginId) => {
      const permissionManager = window.__PLUGIN_PERMISSION_MANAGER__;
      if (!permissionManager) {
        console.error("[QobuzSearch] Permission manager not available");
        throw new Error("Permission system not initialized");
      }
      try {
        await permissionManager.validateAccess(callerPluginId, "Qobuz Search", "searchCover");
      } catch (error) {
        console.error("[QobuzSearch] Permission denied:", error.message);
        throw error;
      }
      return QobuzSearch.searchCoverForRPC(title, artist, trackId);
    },
  };

  if (typeof Audion !== "undefined" && Audion.register) {
    Audion.register(QobuzSearch);
  } else {
    window.QobuzSearch = QobuzSearch;
    window.AudionPlugin = QobuzSearch;
  }
})();