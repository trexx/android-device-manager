import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConnectedDevice } from "../context/DeviceContext";
import {
  LEVEL_NAMES,
  LOG_LEVELS,
  levelRank,
  parseLogcatLine,
  spawnLogcat,
  type LogLevel,
  type LogRecord,
} from "../lib/logcat";

const MAX_RECORDS = 5000; // ring buffer cap
const ROW_H = 18; // px; must match .lc-row line-height
const FLUSH_MS = 250; // batch UI updates
const OVERSCAN = 12; // extra rows above/below the viewport

export function LogcatViewer({ device }: { device: ConnectedDevice }) {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [minLevel, setMinLevel] = useState<LogLevel>("V");
  const [tagFilter, setTagFilter] = useState("");
  const [pidFilter, setPidFilter] = useState("");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<LogRecord[]>([]);
  const dirtyRef = useRef(false);
  const pausedRef = useRef(false);
  const autoScrollRef = useRef(true);
  const idRef = useRef(0);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  // Stream logcat for the lifetime of the panel.
  useEffect(() => {
    let disposed = false;
    let kill = () => {};
    bufferRef.current = [];
    setRecords([]);
    idRef.current = 0;
    setError(null);

    (async () => {
      try {
        const stream = await spawnLogcat(device.adb);
        kill = stream.kill;
        if (disposed) {
          stream.kill();
          return;
        }
        const reader = stream.output.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line.length === 0) continue;
            const records_ = bufferRef.current;
            records_.push(parseLogcatLine(line, idRef.current++));
            if (records_.length > MAX_RECORDS) {
              records_.splice(0, records_.length - MAX_RECORDS);
            }
            dirtyRef.current = true;
          }
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      kill();
    };
  }, [device]);

  // Batch buffer -> state so a busy log doesn't re-render per line. The view is
  // frozen while paused OR while scrolled up — so incoming lines (and ring-buffer
  // trimming) never shift what you're reading. Lines keep accumulating in the
  // buffer and the view resumes tailing once you return to the bottom.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!pausedRef.current && autoScrollRef.current && dirtyRef.current) {
        dirtyRef.current = false;
        setRecords(bufferRef.current.slice());
      }
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  // Track the viewport height for virtualization.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const filtered = useMemo(() => {
    const min = levelRank(minLevel);
    const tagQ = tagFilter.trim().toLowerCase();
    const pidQ = pidFilter.trim();
    return records.filter((rec) => {
      if (rec.level && levelRank(rec.level) < min) return false;
      if (tagQ && !rec.tag.toLowerCase().includes(tagQ)) return false;
      if (pidQ && String(rec.pid) !== pidQ) return false;
      return true;
    });
  }, [records, minLevel, tagFilter, pidFilter]);

  // Follow the tail while auto-scroll is on (and whenever the list grows).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    setAutoScroll(atBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setAutoScroll(true);
    // Flush any lines buffered while scrolled up; the layout effect scrolls to
    // the new bottom once they render.
    if (dirtyRef.current) {
      dirtyRef.current = false;
      setRecords(bufferRef.current.slice());
    }
  }, []);

  const clear = useCallback(() => {
    bufferRef.current = [];
    dirtyRef.current = false;
    setRecords([]);
  }, []);

  const searchQ = search.trim().toLowerCase();
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(filtered.length, start + Math.ceil(viewportH / ROW_H) + OVERSCAN * 2);
  const windowed = filtered.slice(start, end);

  return (
    <div className="logcat">
      <div className="lc-toolbar">
        <label className="lc-field">
          <span>Min level</span>
          <select value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogLevel)}>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
        <input
          className="lc-input"
          placeholder="tag"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
        />
        <input
          className="lc-input lc-pid"
          placeholder="pid"
          inputMode="numeric"
          value={pidFilter}
          onChange={(e) => setPidFilter(e.target.value)}
        />
        <input
          className="lc-input"
          placeholder="search (highlight)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button onClick={() => setPaused((p) => !p)} className={paused ? "active" : ""}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={clear}>Clear</button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="lc-list-wrap">
        <div className="lc-list" ref={containerRef} onScroll={onScroll}>
          <div className="lc-spacer" style={{ height: filtered.length * ROW_H }}>
            {windowed.map((rec, i) => {
              const matched =
                searchQ.length > 0 &&
                (rec.message.toLowerCase().includes(searchQ) ||
                  rec.tag.toLowerCase().includes(searchQ));
              return (
                <div
                  key={rec.id}
                  className={`lc-row lvl-${rec.level ?? "none"}${matched ? " lc-match" : ""}`}
                  style={{ top: (start + i) * ROW_H, height: ROW_H }}
                  title={rec.message}
                >
                  {rec.level ? (
                    <>
                      <span className="lc-time">{rec.timestamp}</span>
                      <span className="lc-pid">
                        {rec.pid}-{rec.tid}
                      </span>
                      <span className="lc-lvl">{rec.level}</span>
                      <span className="lc-tag">{rec.tag}</span>
                      <span className="lc-msg">{rec.message}</span>
                    </>
                  ) : (
                    <span className="lc-sep">{rec.message}</span>
                  )}
                </div>
              );
            })}
          </div>
          {filtered.length === 0 && <p className="muted fb-empty">Waiting for logs…</p>}
        </div>
        {!autoScroll && (
          <button className="lc-jump" onClick={jumpToBottom}>
            ↓ Jump to bottom
          </button>
        )}
      </div>
    </div>
  );
}
