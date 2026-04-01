#!/usr/bin/env node
// Pull analytics for ALL @tinytamiltales videos including Ghost House
import 'dotenv/config';
import { google } from 'googleapis';
import { writeFileSync } from 'fs';

const VIDEO_IDS = {
  EP01_Kavin_Peacock_LongForm:    'F7ZXQVMT9o8',  // public, long-form
  EP02_Minmini_Fireflies:         'eagFew2y21U',   // public, short
  EP04_Tara_Storm:                'IulIAQLUPuk',   // unlisted
  EP05_Boy_SaidNotMe:             'wZ8FS5irOB4',   // unlisted
  EP06_Pongal_HarvestHelper:      'd_VlISFo1hc',   // unlisted
  EP07_Meera_MangoTree:           'S5PCk8JfEQg',   // unlisted
  EP08_Arjun_Meenu_MarketDay:     'Bqi_tCzk4W4',   // unlisted
  EP_GhostHouse_HIT:              'ORyWH1nxn6E',   // THE HIT - Meenu Abandoned Ghost House
};

const DATE_START = '2026-01-01';
const DATE_END   = '2026-03-26';

function getOAuth2Client() {
  const oauth2 = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return oauth2;
}

function isoToSec(d) {
  const m = d?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (+(m[1]||0)*3600) + (+(m[2]||0)*60) + +(m[3]||0);
}

function safe(label, fn) {
  return fn().catch(e => { console.warn(`⚠️ ${label}: ${e.message}`); return {_error: e.message}; });
}

function rowsToObj(report) {
  if (!report || report._error || !report.data?.columnHeaders) return null;
  const headers = report.data.columnHeaders.map(h => h.name);
  return (report.data.rows || []).map(r => Object.fromEntries(headers.map((h,i) => [h, r[i]])));
}

async function main() {
  console.log('🚀 Pulling full analytics for all TTT videos...\n');
  const auth = getOAuth2Client();
  const yt = google.youtube({ version: 'v3', auth });
  const ya = google.youtubeAnalytics({ version: 'v2', auth });

  // Channel ID
  const chRes = await yt.channels.list({ part: ['snippet','statistics'], mine: true });
  const channel = chRes.data.items?.[0];
  const channelId = channel?.id;
  console.log(`Channel: ${channel?.snippet?.title} (${channelId})`);
  console.log(`Subs: ${channel?.statistics?.subscriberCount}, Views: ${channel?.statistics?.viewCount}, Videos: ${channel?.statistics?.videoCount}\n`);

  // Video metadata
  const allIds = Object.values(VIDEO_IDS);
  const vidRes = await yt.videos.list({
    part: ['snippet','statistics','contentDetails','status'],
    id: allIds,
  });

  const vidMap = {};
  for (const v of vidRes.data.items || []) {
    vidMap[v.id] = {
      id: v.id,
      title: v.snippet?.title,
      description: v.snippet?.description?.slice(0, 500),
      publishedAt: v.snippet?.publishedAt,
      tags: v.snippet?.tags,
      privacyStatus: v.status?.privacyStatus,
      madeForKids: v.status?.madeForKids,
      durationSec: isoToSec(v.contentDetails?.duration),
      dimension: v.contentDetails?.dimension,
      stats: {
        views: +v.statistics?.viewCount || 0,
        likes: +v.statistics?.likeCount || 0,
        comments: +v.statistics?.commentCount || 0,
      },
      thumbnail: v.snippet?.thumbnails?.maxres?.url || v.snippet?.thumbnails?.high?.url,
    };
  }

  // Per-video analytics
  const analytics = {};
  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    console.log(`📈 Fetching analytics: ${label} (${videoId})...`);

    const base = await safe(`base ${label}`, () => ya.reports.query({
      ids: `channel==${channelId}`,
      startDate: DATE_START, endDate: DATE_END,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,shares,comments',
      filters: `video==${videoId}`,
      dimensions: 'day',
    }));

    const traffic = await safe(`traffic ${label}`, () => ya.reports.query({
      ids: `channel==${channelId}`,
      startDate: DATE_START, endDate: DATE_END,
      metrics: 'views,estimatedMinutesWatched',
      filters: `video==${videoId}`,
      dimensions: 'insightTrafficSourceType',
      sort: '-views',
    }));

    const geo = await safe(`geo ${label}`, () => ya.reports.query({
      ids: `channel==${channelId}`,
      startDate: DATE_START, endDate: DATE_END,
      metrics: 'views,estimatedMinutesWatched',
      filters: `video==${videoId}`,
      dimensions: 'country',
      sort: '-views',
      maxResults: 15,
    }));

    const device = await safe(`device ${label}`, () => ya.reports.query({
      ids: `channel==${channelId}`,
      startDate: DATE_START, endDate: DATE_END,
      metrics: 'views',
      filters: `video==${videoId}`,
      dimensions: 'deviceType',
    }));

    const ageGender = await safe(`age ${label}`, () => ya.reports.query({
      ids: `channel==${channelId}`,
      startDate: DATE_START, endDate: DATE_END,
      metrics: 'viewerPercentage',
      filters: `video==${videoId}`,
      dimensions: 'ageGroup,gender',
    }));

    // Aggregate totals
    const baseRows = rowsToObj(base) || [];
    const totalViews = baseRows.reduce((s, r) => s + (+r.views||0), 0);
    const totalMins  = baseRows.reduce((s, r) => s + (+r.estimatedMinutesWatched||0), 0);
    const subGained  = baseRows.reduce((s, r) => s + (+r.subscribersGained||0), 0);
    const totalLikes = baseRows.reduce((s, r) => s + (+r.likes||0), 0);
    const totalShares = baseRows.reduce((s, r) => s + (+r.shares||0), 0);
    const avgViewDur = baseRows.length ? baseRows[baseRows.length-1]?.averageViewDuration : null;
    const avgViewPct = baseRows.length ? baseRows[baseRows.length-1]?.averageViewPercentage : null;

    analytics[label] = {
      videoId,
      totalViews,
      totalMins,
      subGained,
      totalLikes,
      totalShares,
      avgViewDurSec: avgViewDur,
      avgViewPct,
      traffic: rowsToObj(traffic),
      geo: rowsToObj(geo),
      device: rowsToObj(device),
      ageGender: rowsToObj(ageGender),
      dailyRows: baseRows,
    };
  }

  // Search queries channel-level
  const searchQ = await safe('search queries', () => ya.reports.query({
    ids: `channel==${channelId}`,
    startDate: DATE_START, endDate: DATE_END,
    metrics: 'views',
    dimensions: 'insightTrafficSourceDetail',
    filters: 'insightTrafficSourceType==YT_SEARCH',
    sort: '-views',
    maxResults: 30,
  }));

  // Build readable report
  const lines = [];
  lines.push('# @tinytamiltales — Full Analytics Report (All Episodes)');
  lines.push(`**Date range:** ${DATE_START} → ${DATE_END}`);
  lines.push(`**Channel:** ${channel?.snippet?.title} | Subs: ${channel?.statistics?.subscriberCount} | Total Views: ${channel?.statistics?.viewCount}\n`);

  lines.push('## 📊 Video Performance Comparison\n');
  lines.push('| Video | Status | Duration | Views (API) | Views (Analytics) | Avg View % | Avg View Dur | Subs Gained | Likes | Shares |');
  lines.push('|-------|--------|----------|-------------|-------------------|------------|--------------|-------------|-------|--------|');

  const TRAFFIC_MAP = {
    SHORT: '📱 Shorts Feed', YT_SEARCH: '🔍 Search', SUGGESTED_VIDEOS: '💡 Suggested',
    SUBSCRIBER: '🔔 Subs', BROWSE_FEATURES: '🏠 Browse', EXTERNAL: '🌐 External',
    NOTIFICATION: '🔔 Notif', END_SCREEN: '🔚 End Screen', DIRECT_OR_UNKNOWN: '❓ Direct',
  };

  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    const v = vidMap[videoId] || {};
    const a = analytics[label] || {};
    const dur = v.durationSec != null ? `${Math.floor(v.durationSec/60)}m${v.durationSec%60}s` : 'N/A';
    const avgPct = a.avgViewPct != null ? `${(+a.avgViewPct).toFixed(1)}%` : 'N/A';
    const avgDur = a.avgViewDurSec != null ? `${Math.floor(+a.avgViewDurSec/60)}m${Math.round(+a.avgViewDurSec%60)}s` : 'N/A';
    const shortLabel = label.replace(/_/g,' ').slice(0,40);
    lines.push(`| ${shortLabel} | ${v.privacyStatus||'?'} | ${dur} | ${(v.stats?.views||0).toLocaleString()} | ${(a.totalViews||0).toLocaleString()} | ${avgPct} | ${avgDur} | ${a.subGained||0} | ${a.totalLikes||0} | ${a.totalShares||0} |`);
  }

  lines.push('\n---\n');
  lines.push('## 🔍 Per-Video Deep Dive\n');

  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    const v = vidMap[videoId] || {};
    const a = analytics[label] || {};
    lines.push(`### ${label}`);
    lines.push(`**Title:** ${v.title || videoId}`);
    lines.push(`**Published:** ${v.publishedAt ? new Date(v.publishedAt).toDateString() : 'N/A'} | **Status:** ${v.privacyStatus} | **Duration:** ${v.durationSec ? `${Math.floor(v.durationSec/60)}m${v.durationSec%60}s` : 'N/A'}`);
    lines.push(`**Tags:** ${v.tags?.join(', ') || 'none'}`);
    lines.push(`**Description snippet:** ${v.description?.slice(0,200)||'N/A'}`);
    lines.push('');
    lines.push(`**Views:** ${(v.stats?.views||0).toLocaleString()} (Data API) / ${(a.totalViews||0).toLocaleString()} (Analytics API)`);
    lines.push(`**Watch Time:** ${Math.round(a.totalMins||0).toLocaleString()} mins | **Avg View %:** ${a.avgViewPct != null ? (+a.avgViewPct).toFixed(1)+'%' : 'N/A'} | **Avg View Dur:** ${a.avgViewDurSec != null ? Math.round(+a.avgViewDurSec)+'s' : 'N/A'}`);
    lines.push(`**Subs Gained:** ${a.subGained||0} | **Likes:** ${a.totalLikes||0} | **Shares:** ${a.totalShares||0}`);

    if (a.traffic?.length) {
      lines.push('\n**Traffic Sources:**');
      for (const t of a.traffic) {
        const name = TRAFFIC_MAP[t.insightTrafficSourceType] || t.insightTrafficSourceType;
        lines.push(`  - ${name}: ${Math.round(+t.views||0).toLocaleString()} views`);
      }
    }

    if (a.geo?.length) {
      lines.push('\n**Top Countries:**');
      for (const g of a.geo.slice(0,6)) {
        lines.push(`  - ${g.country}: ${Math.round(+g.views||0).toLocaleString()} views`);
      }
    }

    if (a.ageGender?.length) {
      lines.push('\n**Age/Gender breakdown:**');
      for (const ag of a.ageGender) {
        lines.push(`  - ${ag.ageGroup} / ${ag.gender}: ${(+ag.viewerPercentage||0).toFixed(1)}%`);
      }
    }

    lines.push('\n---');
  }

  // Search queries
  const sqRows = rowsToObj(searchQ);
  if (sqRows?.length) {
    lines.push('\n## 🔍 Top Search Queries (Channel)\n');
    for (const r of sqRows) {
      lines.push(`- "${r.insightTrafficSourceDetail}" — ${Math.round(+r.views||0)} views`);
    }
  }

  const OUT = '/tmp/ttt-analytics-full.md';
  const JSON_OUT = '/tmp/ttt-analytics-full.json';
  writeFileSync(OUT, lines.join('\n'));
  writeFileSync(JSON_OUT, JSON.stringify({ channel: { id: channelId, stats: channel?.statistics, title: channel?.snippet?.title }, videos: vidMap, analytics, searchQueries: sqRows }, null, 2));
  console.log(`\n✅ Report → ${OUT}`);
  console.log(`✅ JSON → ${JSON_OUT}`);

  // Quick summary to console
  console.log('\n📊 QUICK COMPARISON:');
  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    const v = vidMap[videoId]?.stats || {};
    const a = analytics[label] || {};
    console.log(`  ${label}: views=${v.views||0} | avgPct=${a.avgViewPct != null ? (+a.avgViewPct).toFixed(1)+'%' : 'N/A'} | subs+=${a.subGained||0} | shares=${a.totalShares||0}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
