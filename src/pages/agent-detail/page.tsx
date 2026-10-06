import { useParams } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import AgentHeader from './components/AgentHeader';
import DateFilter from './components/DateFilter';
import AgentKpis from './components/AgentKpis';
import SessionPanel from './components/SessionPanel';
import TimelineChart from './components/TimelineChart';
import BottomTabs from './components/BottomTabs';
import TimePerApp from './components/TimePerApp';
import CaptureControls from './components/CaptureControls';
import EndpointToolsTab from './components/EndpointToolsTab';
import AgentInventoryTab from './components/AgentInventoryTab';
import { detailBottomTabs, type DetailTabId } from '@/mocks/agentDetail';
import { useAgentDetail, type DateRange } from '@/lib/useAgentDetail';
import { useSignedScreenshotUrls, useSignedVideoUrls } from '@/lib/dataHooks';
import { supabase, SUPABASE_URL } from '@/lib/supabase';
import { formatDurationShort, kindColor, prettyKind } from '@/lib/labels';
import { Bar } from '@/pages/dashboard/components/ui';
import { C } from '@/pages/dashboard/components/chartKit';

void detailBottomTabs;

const formatTime = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

/* Width of the derived "kind" caption column, measured from the longest kind
   actually present in the rows being rendered. A fixed px width would either
   clip a long kind or reserve space for kinds this agent never emitted.
   The captions render upper-case, whose glyphs are wider than the `ch` unit
   (the width of "0"), so the measured length gets a 25% allowance. */
const kindWidthCh = (values: string[]) =>
  Math.min(24, Math.ceil(Math.max(6, ...values.map((v) => prettyKind(v).length)) * 1.25));

const formatRelative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [activeTab, setActiveTab] = useState<DetailTabId>('applications');
  const [range, setRange] = useState<DateRange>('today');
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [screenshotPage, setScreenshotPage] = useState(1);
  const SCREENSHOTS_PER_PAGE = 32;
  const { agent, activity, alerts, loading, notFound, refresh, beginSaveWindow } = useAgentDetail(agentId, range);

  // Live refresh every 30s so SYSTEM ON / IDLE / ACTIVE update without a manual reload.
  useEffect(() => {
    const t = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Changing the date range reshapes the row set; snap back to page 1 so the
  // user isn't stranded on an index that no longer exists.
  useEffect(() => { setScreenshotPage(1); }, [range]);

  const updateCaptureSettings = async (p: {
    screenshots: boolean;
    videos: boolean;
    dlp?: boolean;
    removableDisksBlocked?: boolean;
    wallpaperEnforced?: boolean;
    trackingScheduleOverride?: boolean;
    screenshotIntervalSecs: number;
    videoIntervalSecs: number;
  }) => {
    if (!agentId) {
      throw new Error('Missing agent ID — please reload the page.');
    }
    const patch: Record<string, boolean | number> = {
      screenshots_enabled: p.screenshots,
      videos_enabled: p.videos,
      screenshot_interval_secs: p.screenshotIntervalSecs,
      video_interval_secs: p.videoIntervalSecs,
    };
    if (p.dlp !== undefined) patch.dlp_enabled = p.dlp;
    if (p.removableDisksBlocked !== undefined) patch.removable_disks_blocked = p.removableDisksBlocked;
    if (p.wallpaperEnforced !== undefined) patch.wallpaper_enforced = p.wallpaperEnforced;
    if (p.trackingScheduleOverride !== undefined) patch.tracking_schedule_override = p.trackingScheduleOverride;

    // Route through the agent-update-settings edge function instead of a
    // direct supabase.from('agents').update(). Direct RLS writes silently
    // return 0 rows when permission is denied — looks like success in the
    // UI but the DB never changes, and the toggle "reverts" on refresh.
    // The edge function returns a real HTTP error in that case so the user
    // sees what actually happened.
    const { data: sess } = await supabase.auth.getSession();
    const accessToken = sess?.session?.access_token;
    if (!accessToken) {
      throw new Error('Not signed in — please log in again.');
    }
    // Tell useAgentDetail to ignore realtime UPDATE pings on this agent's
    // row for the next 3 seconds. Without this, the agent's ~30s heartbeat
    // can fire a stale refresh that races with our save's refresh — last
    // fetch to return wins, and if the stale one wins the form snaps back.
    beginSaveWindow();
    // === DIAGNOSTIC: log everything ===
    console.log('[SAVE] agent_id=%s patch=%o', agentId, patch);
    const r = await fetch(`${SUPABASE_URL}/functions/v1/agent-update-settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ agent_id: agentId, patch }),
    });
    const responseText = await r.text();
    console.log('[SAVE] response HTTP=%d body=%s', r.status, responseText);
    if (!r.ok) {
      let detail: string;
      try {
        const body = JSON.parse(responseText) as { error?: string; detail?: string };
        detail = body.detail ? `${body.error ?? 'error'}: ${body.detail}` : body.error ?? `HTTP ${r.status}`;
      } catch {
        detail = `HTTP ${r.status}: ${responseText.slice(0, 200)}`;
      }
      throw new Error(`Save failed — ${detail}`);
    }
    console.log('[SAVE] refresh() starting');
    await refresh();
    console.log('[SAVE] refresh() done');
  };

  // Plan-level DLP add-on price.
  //   undefined → still loading (don't show "not available" yet — that flash
  //               is what made customers think DLP toggling was random)
  //   null      → query resolved, plan really doesn't include DLP
  //   number    → DLP is part of the plan at this price per agent per month
  const [dlpAddonPriceInr, setDlpAddonPriceInr] = useState<number | null | undefined>(undefined);
  const [isTrial, setIsTrial] = useState(false);
  useEffect(() => {
    if (!agent?.orgId) return;
    (async () => {
      const [{ data: lic }, { data: orgRow }] = await Promise.all([
        supabase
          .from('licenses')
          .select('plans(dlp_addon_price_inr)')
          .eq('organization_id', agent.orgId)
          .order('issued_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('organizations')
          .select('subscription_status')
          .eq('id', agent.orgId)
          .maybeSingle(),
      ]);
      const price = (lic?.plans as { dlp_addon_price_inr?: number } | null)?.dlp_addon_price_inr;
      setDlpAddonPriceInr(typeof price === 'number' ? price : null);
      setIsTrial((orgRow?.subscription_status as string | null) === 'trial');
    })();
  }, [agent?.orgId]);

  const screenshotPaths = useMemo(
    () => activity.filter((a) => a.activity_type === 'screenshot').map((a) => a.screenshot_url).filter((p): p is string => !!p),
    [activity],
  );
  const signedScreenshots = useSignedScreenshotUrls(screenshotPaths);

  const videoPaths = useMemo(
    () => activity.filter((a) => a.activity_type === 'video').map((a) => a.video_url).filter((p): p is string => !!p),
    [activity],
  );
  const signedVideos = useSignedVideoUrls(videoPaths);
  const videoRows = useMemo(() => activity.filter((a) => a.activity_type === 'video'), [activity]);
  const [videoIdx, setVideoIdx] = useState<number | null>(null);

  if (loading && !agent) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[400px] text-[12px] t3">Loading agent…</div>
      </DashboardLayout>
    );
  }

  if (notFound || !agent) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <span className="w-16 h-16 flex items-center justify-center mx-auto mb-4 t3">
              <i className="ri-error-warning-line text-4xl" />
            </span>
            <h2 className="num mb-2" style={{ fontSize: 17 }}>Agent not found</h2>
            <p className="text-[12px] t3">The agent you are looking for does not exist or you do not have access.</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  const counts: Record<string, number | null> = {
    applications: agent.appsUsed,
    browser: agent.sitesVisited,
    videos: agent.videosCount,
    screenshots: agent.screenshotsCount,
    timeline: null,
    alerts: agent.alertsCount,
    system: null,
    ai: null,
  };

  // Share of system-on time that was active, from the same seconds the two
  // figures are formatted from — no re-parsing of display strings.
  const activeShare = agent.systemOnSeconds > 0
    ? Math.min(100, Math.round((agent.activeSeconds / agent.systemOnSeconds) * 100))
    : null;

  // Plain consts, not useMemo — this point is past the loading/not-found early
  // returns, so a hook here would break hook order.
  const alertKindCh = kindWidthCh(alerts.map((a) => a.alert_type));
  const eventKindCh = kindWidthCh(activity.map((a) => a.activity_type));

  const browserRows = activity.filter((a) => a.activity_type === 'browser');
  const screenshotRows = activity.filter((a) => a.activity_type === 'screenshot');

  return (
    <DashboardLayout>
      <div className="dash min-w-0 max-w-full">
        <div className="flex items-center gap-1.5 text-[10.5px] t3 mb-3">
          <Link to="/dashboard" className="hover:underline flex items-center gap-1">
            <i className="ri-dashboard-line text-[12px]" />
            Dashboard
          </Link>
          <i className="ri-arrow-right-s-line" />
          <Link to="/agents" className="hover:underline">Agents</Link>
          <i className="ri-arrow-right-s-line" />
          <span className="t1 font-medium">{agent.machine}</span>
        </div>

        {/* Identity and the date range share one row — the range is the lens
            everything below is read through, so it belongs with the subject. */}
        <AgentHeader
          agentId={agent.id}
          orgId={agent.orgId}
          name={agent.name}
          machine={agent.machine}
          status={agent.status}
          version={agent.version}
          ipAddress={agent.ipAddress}
          os={agent.os}
          department={agent.department}
          onDepartmentChange={() => { void refresh(); }}
        >
          <DateFilter
            onChange={(preset) => {
              // Custom range arrives as "custom:<fromISO>|<toISO>" — pass
              // straight through; useAgentDetail decodes it.
              if (preset.startsWith('custom:')) {
                setRange(preset as DateRange);
                return;
              }
              const map: Record<string, DateRange> = {
                'Today': 'today', 'Yesterday': 'yesterday',
                '7 days': '7d', '30 days': '30d', 'All time': 'all',
              };
              setRange(map[preset] ?? 'today');
            }}
          />
        </AgentHeader>

        <div className="mt-3">
          <AgentKpis
            activeWorked={agent.activeWorked}
            idleTime={agent.idleTime ?? '0h 00m'}
            systemOn={agent.systemOn}
            appsUsed={agent.appsUsed}
            sitesVisited={agent.sitesVisited}
            alertsCount={agent.alertsCount}
            activeShare={activeShare}
            rangeLabel="in this window"
            daysCovered={agent.daysCovered}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 mt-3">
          <div className="lg:col-span-8 min-w-0 flex">
            <TimelineChart
              data={agent.timeline}
              bucketMinutes={agent.timelineBucketMinutes}
              index={1}
            />
          </div>
          <div className="lg:col-span-4 min-w-0 flex">
            <SessionPanel
              firstLogin={agent.firstLogin}
              lastActivity={agent.lastActivity}
              stillActive={agent.stillActive}
              logins={agent.logins}
              logouts={agent.logouts}
              daysCovered={agent.daysCovered}
              index={2}
            />
          </div>
        </div>

        <div className="mt-5 mb-3">
          <BottomTabs active={activeTab} onChange={setActiveTab} counts={counts} />
        </div>

        {activeTab === 'applications' && <TimePerApp apps={agent.appsTime} index={3} />}

        {activeTab === 'browser' && (() => {
          const visible = browserRows.slice(-30).reverse();
          const noUrlCount = visible.filter((r) => !((r.url ?? '').trim().startsWith('http'))).length;
          const showAutomationHint = visible.length > 0 && noUrlCount / visible.length > 0.4;
          return (
            <div className="space-y-3">
              {showAutomationHint && (
                <div className="banner is-notice">
                  <span className="flex items-start gap-2 min-w-0">
                  <i className="ri-information-line text-[13px] t-warning mt-px" />
                  <div className="min-w-0">
                    <p className="text-[11.5px] t-warning font-medium">Many sessions are missing URLs</p>
                    {(() => {
                      const os = (agent.os ?? '').toLowerCase();
                      if (os.includes('mac')) {
                        return (
                          <p className="text-[11px] t3 leading-relaxed mt-0.5">
                            On macOS, grant Automation permission so the agent can read browser tab URLs.
                            System Settings → Privacy &amp; Security → Automation → Security Assistant → enable Chrome / Brave / Safari.
                          </p>
                        );
                      }
                      if (os.includes('win')) {
                        return (
                          <p className="text-[11px] t3 leading-relaxed mt-0.5">
                            On Windows, the agent reads URLs through the OS UI Automation API. If URLs are still missing,
                            ensure PowerShell + .NET 4.x are available and the browser window is visible (UIA cannot read
                            minimised or background windows). Restart the agent after browser updates.
                          </p>
                        );
                      }
                      if (os.includes('ubuntu') || os.includes('linux')) {
                        return (
                          <p className="text-[11px] t3 leading-relaxed mt-0.5">
                            On Linux, browser URL extraction is not yet implemented — only window titles are captured.
                            Install xdotool / wmctrl for richer window metadata.
                          </p>
                        );
                      }
                      return (
                        <p className="text-[11px] t3 leading-relaxed mt-0.5">
                          The agent could not extract tab URLs from the browser. Check the agent&apos;s OS-specific
                          permissions and ensure the browser window is on the foreground.
                        </p>
                      );
                    })()}
                  </div>
                  </span>
                </div>
              )}
              <div className="panel overflow-hidden">
                {browserRows.length === 0 ? (
                  <div className="p-8 text-center text-[12px] t3">No browser activity in this window.</div>
                ) : (() => {
                  // Only render a column some row can actually fill. Page Title
                  // and Browser are blank on every row unless the agent has the
                  // OS permission to read them, and five columns of "—" spread
                  // the three real values across the full panel width.
                  const hasTitle = visible.some((r) => (r.page_title ?? '').trim());
                  const hasApp = visible.some((r) => (r.application_name ?? '').trim());
                  // Longest visit in view — the bar in the duration cell is
                  // relative to it, so the column that would otherwise be a
                  // 300px gap between the site and its number carries the
                  // comparison instead.
                  const longest = Math.max(1, ...visible.map((r) => r.duration ?? 0));
                  return (
                    <table className="d-table">
                      <thead>
                        <tr className="hair-b">
                          <th style={{ width: hasTitle || hasApp ? '22%' : 240 }}>Website</th>
                          {hasTitle && <th>Page title</th>}
                          {hasApp && <th style={{ width: 120 }}>Browser</th>}
                          <th className="text-right">Duration</th>
                          <th className="text-right" style={{ width: 74 }}>Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((r, i) => {
                          const url = (r.url ?? '').trim();
                          const title = (r.page_title ?? '').trim();
                          const app = (r.application_name ?? '').trim();
                          let host = '';
                          try { if (url) host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
                          const isUrl = url.startsWith('http');
                          return (
                            <tr key={i}>
                              <td className="max-w-[280px]">
                                {isUrl ? (
                                  <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[11.5px] t-accent hover:underline truncate block"
                                    title={url}
                                  >
                                    {host || url}
                                  </a>
                                ) : (
                                  <span className="text-[11.5px] t3" title="The agent could not read the tab URL">
                                    no URL
                                  </span>
                                )}
                              </td>
                              {hasTitle && (
                                <td className="max-w-[380px]">
                                  <span className="text-[11.5px] t2 truncate block" title={title || undefined}>
                                    {title || '—'}
                                  </span>
                                </td>
                              )}
                              {hasApp && <td className="text-[11px] t3">{app || '—'}</td>}
                              <td>
                                <span className="flex items-center gap-2.5 justify-end">
                                  <span className="flex-1 min-w-[40px] hidden sm:block">
                                    <Bar
                                      pct={((r.duration ?? 0) / longest) * 100}
                                      height={4}
                                      color={C.accent}
                                    />
                                  </span>
                                  <span className="text-[11.5px] t2 tnum text-right w-[42px]">
                                    {formatDurationShort(r.duration ?? 0)}
                                  </span>
                                </span>
                              </td>
                              <td className="text-right text-[11px] t3 whitespace-nowrap tnum">{formatTime(r.created_at)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            </div>
          );
        })()}

        {activeTab === 'screenshots' && (() => {
          // screenshotRows is DESC-sorted (newest first) by useAgentDetail.
          // Previously the UI did `.slice(-40).reverse()` which actually
          // returned the OLDEST 40 of the window — users with a tenant
          // saw their first-ever screenshots instead of today's.
          const totalPages = Math.max(1, Math.ceil(screenshotRows.length / SCREENSHOTS_PER_PAGE));
          const safePage = Math.min(screenshotPage, totalPages);
          const startIdx = (safePage - 1) * SCREENSHOTS_PER_PAGE;
          const recent = screenshotRows.slice(startIdx, startIdx + SCREENSHOTS_PER_PAGE);
          return (
            <div className="panel p-4">
              {recent.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="ri-camera-line text-[22px] t3 block mb-2" />
                  <p className="text-[12.5px] t2">No screenshots captured yet.</p>
                  <p className="text-[11px] t3 mt-1">
                    Captures appear here when screenshots are enabled in Capture controls.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {recent.map((r, i) => {
                    const path = r.screenshot_url;
                    const url = path ? signedScreenshots[path] : null;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => url && setLightboxIdx(i)}
                        className="group sunken rounded-lg overflow-hidden text-left tile-media"
                      >
                        <div className="relative aspect-video">
                          {url ? (
                            <>
                              <img src={url} alt="" className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                                <span className="opacity-0 group-hover:opacity-100 transition-opacity w-10 h-10 flex items-center justify-center rounded-full bg-white/90">
                                  <i className="ri-zoom-in-line text-dark-900 text-base" />
                                </span>
                              </div>
                            </>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center t3">
                              <i className="ri-image-line text-2xl" />
                            </div>
                          )}
                        </div>
                        <div className="px-2.5 py-2 flex items-center justify-between">
                          <p className="text-[11px] t2 tnum">{formatTime(r.created_at)}</p>
                          <span className="text-[10px] t3">#{screenshotRows.length - (startIdx + i)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {screenshotRows.length > SCREENSHOTS_PER_PAGE && (
                <div className="mt-4 flex items-center justify-between text-[12px]">
                  <p className="t3 tnum">
                    Showing {startIdx + 1}–{Math.min(startIdx + SCREENSHOTS_PER_PAGE, screenshotRows.length)} of {screenshotRows.length}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setScreenshotPage(1)}
                      className="px-2 py-1 rounded sunken t2 hover:bg-dark-700/40 disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label="First page">
                      <i className="ri-skip-back-mini-line" />
                    </button>
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setScreenshotPage((p) => Math.max(1, p - 1))}
                      className="px-3 py-1 rounded sunken t2 hover:bg-dark-700/40 disabled:opacity-40 disabled:cursor-not-allowed">
                      <i className="ri-arrow-left-s-line" /> Prev
                    </button>
                    <span className="px-2 t2 tnum">Page {safePage} of {totalPages}</span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setScreenshotPage((p) => Math.min(totalPages, p + 1))}
                      className="px-3 py-1 rounded sunken t2 hover:bg-dark-700/40 disabled:opacity-40 disabled:cursor-not-allowed">
                      Next <i className="ri-arrow-right-s-line" />
                    </button>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setScreenshotPage(totalPages)}
                      className="px-2 py-1 rounded sunken t2 hover:bg-dark-700/40 disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label="Last page">
                      <i className="ri-skip-forward-mini-line" />
                    </button>
                  </div>
                </div>
              )}

              {lightboxIdx !== null && recent[lightboxIdx] && (() => {
                const cur = recent[lightboxIdx];
                const url = cur.screenshot_url ? signedScreenshots[cur.screenshot_url] : null;
                const prev = () => setLightboxIdx((idx) => idx === null ? null : Math.min(recent.length - 1, idx + 1));
                const next = () => setLightboxIdx((idx) => idx === null ? null : Math.max(0, idx - 1));
                const close = () => setLightboxIdx(null);
                return (
                  <div
                    className="fixed inset-0 z-[100] bg-black/90 flex flex-col"
                    onClick={close}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') close();
                      else if (e.key === 'ArrowLeft') prev();
                      else if (e.key === 'ArrowRight') next();
                    }}
                    tabIndex={-1}
                    ref={(el) => el?.focus()}
                  >
                    <div className="flex items-center justify-between px-5 py-3 bg-dark-900/80 backdrop-blur" onClick={(e) => e.stopPropagation()}>
                      <div>
                        <p className="text-[12.5px] t1 font-medium">
                          {new Date(cur.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-[11px] text-gray-300">
                          Screenshot {screenshotRows.length - (startIdx + lightboxIdx)} of {screenshotRows.length}
                          {totalPages > 1 && <> · page {safePage} of {totalPages}</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" download
                            className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                            <i className="ri-download-line mr-1" /> Download
                          </a>
                        )}
                        <button onClick={close} className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                          <i className="ri-close-line text-lg" />
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 flex items-center justify-center p-4 relative" onClick={(e) => e.stopPropagation()}>
                      {url ? (
                        <img src={url} alt="" className="max-w-full max-h-full object-contain rounded shadow-2xl" />
                      ) : (
                        <div className="text-gray-300 text-sm">Loading…</div>
                      )}

                      {lightboxIdx < recent.length - 1 && (
                        <button onClick={prev}
                          className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-left-s-line text-2xl" />
                        </button>
                      )}
                      {lightboxIdx > 0 && (
                        <button onClick={next}
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-right-s-line text-2xl" />
                        </button>
                      )}
                    </div>

                    <div className="px-5 py-3 bg-dark-900/80 backdrop-blur text-center text-[11px] text-gray-400" onClick={(e) => e.stopPropagation()}>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">←</kbd> previous
                      <span className="mx-2">·</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">→</kbd> next
                      <span className="mx-2">·</span>
                      <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-gray-200">Esc</kbd> close
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {activeTab === 'alerts' && (
          <div className="panel overflow-hidden">
            {alerts.length === 0 ? (
              <div className="p-8 text-center">
                <i className="ri-notification-off-line text-[22px] t3 block mb-2" />
                <p className="text-[12.5px] t2">No alerts in this window</p>
                <p className="text-[11px] t3 mt-1">
                  Alerts are filtered by the selected date range — widen it to see older ones.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--d-line-soft)]">
                {alerts.map((a) => (
                  <div key={a.id} className="px-3.5 py-2 flex items-center gap-2.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: kindColor(a.alert_type) }}
                    />
                    <span
                      className="text-[9.5px] uppercase tracking-wide flex-shrink-0 truncate"
                      style={{ color: kindColor(a.alert_type), width: `${alertKindCh}ch` }}
                    >
                      {prettyKind(a.alert_type)}
                    </span>
                    <span className="text-[12px] t1 truncate min-w-0 flex-1" title={a.message}>
                      {a.message}
                    </span>
                    {a.ai_resolved && (
                      <span
                        className="chip chip-success text-[9.5px] flex-shrink-0"
                        title={a.resolution ?? 'Resolved'}
                      >
                        <i className="ri-check-line" />
                        resolved
                      </span>
                    )}
                    <span className="text-[10.5px] t3 flex-shrink-0 tnum text-right">
                      {formatRelative(a.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'timeline' && (() => {
          // Caption and colour are derived from activity_type itself (see
          // lib/labels) — the old table mapped six known strings to Tailwind
          // greys/blues and rendered anything else as an unlabelled grey dot.
          const groups: Record<string, typeof activity> = {};
          for (const r of activity.slice(-300).reverse()) {
            const day = new Date(r.created_at).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
            if (!groups[day]) groups[day] = [];
            groups[day].push(r);
          }
          if (activity.length === 0) {
            return (
              <div className="panel p-8 text-center">
                <i className="ri-time-line text-[22px] t3 block mb-2" />
                <p className="text-[12.5px] t2">No activity recorded yet.</p>
                <p className="text-[11px] t3 mt-1">Activity will appear here as the agent reports back.</p>
              </div>
            );
          }
          return (
            <div className="panel overflow-hidden">
              <div className="max-h-[600px] overflow-y-auto">
                {Object.entries(groups).map(([day, rows]) => (
                  <div key={day}>
                    <div
                      className="sticky top-0 z-10 backdrop-blur px-3.5 py-1.5 hair-b flex items-center justify-between"
                      style={{ background: 'var(--d-panel)' }}
                    >
                      <span className="label">{day}</span>
                      <span className="text-[10px] t3">{rows.length} events</span>
                    </div>
                    <ul className="divide-y divide-[var(--d-line-soft)]">
                      {rows.map((r, i) => {

                        const url = (r.url ?? '').trim();
                        const title = (r.page_title ?? '').trim();
                        const app = (r.application_name ?? '').trim();
                        let host = '';
                        try { if (url.startsWith('http')) host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
                        // The kind now has its own column, so this holds only
                        // what the kind doesn't already say — no "Screenshot ·
                        // Screenshot captured".
                        const primary =
                          r.activity_type === 'browser' ? (host || app || '—') :
                          r.activity_type === 'idle' ? formatDurationShort(r.duration ?? 0) :
                          (app || '');
                        const secondary =
                          r.activity_type === 'browser' ? (title || (url && !url.startsWith('http') ? url : '')) :
                          (app && primary !== app ? app : '');
                        return (
                          <li key={i} className="flex items-center gap-2.5 px-3.5 py-1.5 cell">
                            <span
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: kindColor(r.activity_type) }}
                            />
                            <span
                              className="text-[9.5px] uppercase tracking-wide flex-shrink-0 truncate"
                              style={{ color: kindColor(r.activity_type), width: `${eventKindCh}ch` }}
                            >
                              {prettyKind(r.activity_type)}
                            </span>
                            <span
                              className="text-[12px] t1 font-medium truncate flex-shrink-0 max-w-[34%]"
                              title={primary}
                            >
                              {primary}
                            </span>
                            {secondary && (
                              <span className="text-[11px] t3 truncate min-w-0" title={secondary}>
                                {secondary}
                              </span>
                            )}
                            <span className="ml-auto flex items-center gap-3 flex-shrink-0 text-[10.5px] t3 tnum">
                              {(r.duration ?? 0) > 0 && r.activity_type !== 'idle' && (
                                <span>{formatDurationShort(r.duration ?? 0)}</span>
                              )}
                              <span>{formatTime(r.created_at)}</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {activeTab === 'videos' && (() => {
          const recent = videoRows.slice(-40).reverse();
          return (
            <div className="panel p-4">
              {recent.length === 0 ? (
                <div className="p-8 text-center">
                  <i className="ri-video-line text-[22px] t3 block mb-2" />
                  <p className="text-[12.5px] t2">No video clips yet.</p>
                  <p className="text-[11px] t2 mt-1">
                    Enable Video Recording in Capture Controls and ensure ffmpeg is installed.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {recent.map((r, i) => {
                    const url = r.video_url ? signedVideos[r.video_url] : null;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => url && setVideoIdx(i)}
                        className="group sunken rounded-lg overflow-hidden text-left tile-media"
                      >
                        <div className="relative aspect-video bg-black">
                          {url ? (
                            <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center t3">
                              <i className="ri-video-line text-2xl" />
                            </div>
                          )}
                          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                            <span className="w-12 h-12 flex items-center justify-center rounded-full bg-white/90">
                              <i className="ri-play-fill text-dark-900 text-xl" />
                            </span>
                          </div>
                          <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] text-white font-medium">
                            {r.duration ?? 10}s
                          </div>
                        </div>
                        <div className="px-2.5 py-2 flex items-center justify-between">
                          <p className="text-[11px] t2 tnum">{formatTime(r.created_at)}</p>
                          <span className="text-[10px] t3">#{recent.length - i}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {videoIdx !== null && recent[videoIdx] && (() => {
                const cur = recent[videoIdx];
                const url = cur.video_url ? signedVideos[cur.video_url] : null;
                const prev = () => setVideoIdx((idx) => idx === null ? null : Math.min(recent.length - 1, idx + 1));
                const next = () => setVideoIdx((idx) => idx === null ? null : Math.max(0, idx - 1));
                const close = () => setVideoIdx(null);
                return (
                  <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col" onClick={close}>
                    <div className="flex items-center justify-between px-5 py-3 bg-dark-900/80 backdrop-blur" onClick={(e) => e.stopPropagation()}>
                      <div>
                        <p className="text-[12.5px] t1 font-medium">
                          {new Date(cur.created_at).toLocaleString([], { weekday: 'short', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-[11px] text-gray-300">Clip {videoIdx + 1} of {recent.length} · {cur.duration ?? 10}s</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {url && (
                          <a href={url} target="_blank" rel="noreferrer" download
                            className="px-3 py-1.5 text-xs rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                            <i className="ri-download-line mr-1" /> Download
                          </a>
                        )}
                        <button onClick={close} className="w-8 h-8 flex items-center justify-center rounded-lg bg-dark-700 hover:bg-dark-600 text-white">
                          <i className="ri-close-line text-lg" />
                        </button>
                      </div>
                    </div>
                    <div className="flex-1 flex items-center justify-center p-4 relative" onClick={(e) => e.stopPropagation()}>
                      {url ? (
                        <video src={url} controls autoPlay className="max-w-full max-h-full rounded shadow-2xl" />
                      ) : (
                        <div className="text-gray-300 text-sm">Loading…</div>
                      )}
                      {videoIdx < recent.length - 1 && (
                        <button onClick={prev}
                          className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-left-s-line text-2xl" />
                        </button>
                      )}
                      {videoIdx > 0 && (
                        <button onClick={next}
                          className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center rounded-full bg-dark-800/80 hover:bg-dark-700 text-white shadow-lg">
                          <i className="ri-arrow-right-s-line text-2xl" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {activeTab === 'system' && <AgentSystemHealthPanel agentId={agentId!} />}

        {activeTab === 'inventory' && <AgentInventoryTab agentId={agentId!} />}

        {activeTab === 'capture' && (
          <CaptureControls
            screenshotsEnabled={agent.screenshotsEnabled}
            videosEnabled={agent.videosEnabled}
            dlpEnabled={agent.dlpEnabled}
            removableDisksBlocked={agent.removableDisksBlocked}
            wallpaperEnforced={agent.wallpaperEnforced}
          trackingScheduleOverride={agent.trackingScheduleOverride}
            screenshotIntervalSecs={agent.screenshotIntervalSecs}
            videoIntervalSecs={agent.videoIntervalSecs}
            dlpAddonPriceInr={dlpAddonPriceInr}
            isTrial={isTrial}
            onUpdate={updateCaptureSettings}
          />
        )}

        {activeTab === 'tools' && (
          <EndpointToolsTab
            agentId={agentId!}
            agentName={agent.name}
            osType={agent.os}
          />
        )}

      </div>
    </DashboardLayout>
  );
}

// Per-agent System Health card — was a "open the dedicated page" placeholder
// before, which gave the customer no signal even though metrics rows were
// flowing in fine. Show the latest CPU / RAM / disk / battery / network from
// system_metrics for this specific agent, plus a deep-link to the dedicated
// dashboard for historical charts.
function AgentSystemHealthPanel({ agentId }: { agentId: string }) {
  type Row = {
    cpu_usage: number | null;
    ram_usage: number | null;
    disk_usage: number | null;
    disk_activity: number | null;
    battery_level: number | null;
    network_speed: string | null;
    recorded_at: string;
  };
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const fetchLatest = async () => {
      const { data } = await supabase
        .from('system_metrics')
        .select('cpu_usage, ram_usage, disk_usage, disk_activity, battery_level, network_speed, recorded_at')
        .eq('agent_id', agentId)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setRow((data as Row | null) ?? null);
      setStale(data ? Date.now() - new Date(data.recorded_at).getTime() > 5 * 60 * 1000 : true);
      setLoading(false);
    };
    void fetchLatest();
    const id = setInterval(fetchLatest, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [agentId]);

  // Utilisation tone. Battery reads the other way round — 15% left is the
  // problem, not 85% — so it gets inverted rather than being painted green at
  // the point it is about to die.
  const toneFor = (label: string, val: number | null | undefined) => {
    if (val == null) return C.neutral;
    // Battery reads the other way round (15% left is the problem), and a full-ish
    // drive only matters much later than a busy CPU.
    const pressure = label === 'Battery' ? 100 - val : val;
    const watch = label === 'Disk space' ? 80 : 60;
    const high = label === 'Disk space' ? 90 : 80;
    return pressure > high ? C.danger : pressure > watch ? C.warning : C.success;
  };

  if (loading) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-[12px] t3">Loading system health…</p>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="panel p-8 text-center">
        <p className="text-[12px] t3">No metrics yet — agent hasn't reported in the last 30 minutes.</p>
      </div>
    );
  }

  const cards: Array<{ label: string; value: number | null; suffix?: string; icon: string }> = [
    { label: 'CPU', value: row.cpu_usage, suffix: '%', icon: 'ri-cpu-line' },
    { label: 'Memory', value: row.ram_usage, suffix: '%', icon: 'ri-database-2-line' },
    // Two separate disk facts. "Disk" is I/O activity (what Task Manager shows);
    // "Disk space" is how full the drive is. Showing only the latter under the
    // bare label "Disk" made a 63%-full idle drive read as 63% disk load.
    { label: 'Disk', value: row.disk_activity, suffix: '%', icon: 'ri-hard-drive-2-line' },
    { label: 'Disk space', value: row.disk_usage, suffix: '%', icon: 'ri-hard-drive-line' },
    { label: 'Battery', value: row.battery_level, suffix: '%', icon: 'ri-battery-charge-line' },
  ];

  return (
    <div className="panel">
      <header className="panel-head">
        <h3 className="panel-title flex items-center gap-2">
          System health
          {stale && <span className="chip chip-warning text-[9px] uppercase">Stale</span>}
        </h3>
        <span className="text-[10px] t3">
          {new Date(row.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </header>

      <div className="pent-grid">
        {cards.map((c) => (
          <div key={c.label} className="px-3.5 py-3 min-w-0">
            <span className="flex items-center gap-1.5">
              <i className={`${c.icon} text-[12px] t3`} />
              <span className="label">{c.label}</span>
            </span>
            <p className="num num-lg mt-1.5" style={{ color: toneFor(c.label, c.value) }}>
              {c.value == null ? '—' : `${c.value}${c.suffix ?? ''}`}
            </p>
            <span className="block mt-2">
              {c.value != null && (
                <Bar
                  pct={Math.min(100, Math.max(0, c.value))}
                  height={3}
                  color={toneFor(c.label, c.value)}
                />
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="panel-body hair-t flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-1.5 text-[11px] t3">
          <i className="ri-pulse-line text-[12px]" />
          Network
          <span className="t2">{row.network_speed ?? 'not reported'}</span>
        </span>
        <span className="flex items-center gap-3 flex-wrap">
          <span className="text-[10px] t3">Refreshes every 30s · trends on the full page</span>
          <Link to="/system-health" className="chip chip-quiet text-[10.5px]">
            System health
            <i className="ri-arrow-right-up-line" />
          </Link>
        </span>
      </div>
    </div>
  );
}
