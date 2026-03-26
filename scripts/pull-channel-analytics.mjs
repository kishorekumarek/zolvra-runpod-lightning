#!/usr/bin/env node
// scripts/pull-channel-analytics.mjs — Rex-Data: Pull full channel analytics
import 'dotenv/config';
import { google } from 'googleapis';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = '/Users/friday/.openclaw/workspace/streams/youtube/docs';

// Ensure docs dir exists
mkdirSync(DOCS_DIR, { recursive: true });

const VIDEO_IDS = {
  EP01: 'F7ZXQVMT9o8',  // Kavin the Peacock (long-form, public)
  EP02: 'eagFew2y21U',  // Minmini Fireflies (Shorts)
  EP04: 'IulIAQLUPuk',  // Tara and the Storm (unlisted)
};

const DATE_START = '2026-01-01';
const DATE_END   = '2026-03-21';

// ─── Auth ────────────────────────────────────────────────────────────────────

function getOAuth2Client() {
  const clientId     = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing YouTube OAuth credentials in .env');
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tryParse(label, fn) {
  return fn().catch(err => {
    console.warn(`⚠️  ${label} failed: ${err.message}`);
    return { _error: err.message };
  });
}

function isoToSec(duration) {
  // PT1M30S → 90
  const m = duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}

// ─── 1. Channel Stats ────────────────────────────────────────────────────────

async function getChannelStats(youtube) {
  console.log('\n📊 Fetching channel stats...');

  // Try mine:true first, fallback to handle
  let res = await tryParse('channels.list (mine)', () =>
    youtube.channels.list({
      part: ['snippet', 'statistics', 'brandingSettings', 'contentDetails'],
      mine: true,
    })
  );

  if (!res._error && res.data?.items?.length) {
    return res.data.items[0];
  }

  // Brand account fallback
  res = await tryParse('channels.list (handle)', () =>
    youtube.channels.list({
      part: ['snippet', 'statistics', 'brandingSettings', 'contentDetails'],
      forHandle: 'tinytamiltales',
    })
  );

  return res._error ? res : (res.data?.items?.[0] || null);
}

// ─── 2. Video Stats ──────────────────────────────────────────────────────────

async function getVideoStats(youtube, videoIds) {
  console.log('\n🎬 Fetching video metadata + stats...');

  const res = await tryParse('videos.list', () =>
    youtube.videos.list({
      part: ['snippet', 'statistics', 'contentDetails', 'status', 'localizations'],
      id: videoIds,
    })
  );

  if (res._error) return res;

  const items = res.data?.items || [];
  return items.map(v => ({
    id:              v.id,
    title:           v.snippet?.title,
    description:     v.snippet?.description,
    publishedAt:     v.snippet?.publishedAt,
    tags:            v.snippet?.tags,
    categoryId:      v.snippet?.categoryId,
    privacyStatus:   v.status?.privacyStatus,
    duration:        v.contentDetails?.duration,
    durationSec:     isoToSec(v.contentDetails?.duration),
    dimension:       v.contentDetails?.dimension,
    definition:      v.contentDetails?.definition,
    madeForKids:     v.status?.madeForKids,
    statistics: {
      viewCount:     parseInt(v.statistics?.viewCount || 0),
      likeCount:     parseInt(v.statistics?.likeCount || 0),
      commentCount:  parseInt(v.statistics?.commentCount || 0),
      favoriteCount: parseInt(v.statistics?.favoriteCount || 0),
    },
    thumbnail:       v.snippet?.thumbnails?.maxres?.url || v.snippet?.thumbnails?.high?.url,
  }));
}

// ─── 3. YouTube Analytics — per video ────────────────────────────────────────

async function getVideoAnalytics(analyticsClient, channelId, videoId, label) {
  console.log(`  📈 Analytics for ${label} (${videoId})...`);

  const metrics = [
    'views',
    'estimatedMinutesWatched',
    'averageViewDuration',
    'averageViewPercentage',
    'subscribersGained',
    'subscribersLost',
    'likes',
    'dislikes',
    'comments',
    'shares',
    'annotationClickThroughRate',
    'cardClickRate',
  ].join(',');

  const base = await tryParse(`analytics.reports (${label} base)`, () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics,
      filters:    `video==${videoId}`,
      dimensions: 'day',
    })
  );

  // Traffic sources
  const traffic = await tryParse(`analytics.reports (${label} traffic)`, () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched',
      filters:    `video==${videoId}`,
      dimensions: 'insightTrafficSourceType',
      sort:       '-views',
    })
  );

  // Geography
  const geo = await tryParse(`analytics.reports (${label} geo)`, () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched',
      filters:    `video==${videoId}`,
      dimensions: 'country',
      sort:       '-views',
      maxResults: 20,
    })
  );

  // Age + gender
  const demographics = await tryParse(`analytics.reports (${label} demographics)`, () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'viewerPercentage',
      filters:    `video==${videoId}`,
      dimensions: 'ageGroup,gender',
    })
  );

  return { videoId, label, base, traffic, geo, demographics };
}

// ─── 4. Channel-level Analytics ──────────────────────────────────────────────

async function getChannelAnalytics(analyticsClient, channelId) {
  console.log('\n📡 Fetching channel-level analytics...');

  const overview = await tryParse('channel analytics overview', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched,subscribersGained,subscribersLost,comments,likes,shares',
      dimensions: 'day',
      sort:       'day',
    })
  );

  const trafficSources = await tryParse('channel traffic sources', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched',
      dimensions: 'insightTrafficSourceType',
      sort:       '-views',
    })
  );

  const topCountries = await tryParse('channel top countries', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched',
      dimensions: 'country',
      sort:       '-views',
      maxResults: 30,
    })
  );

  const deviceTypes = await tryParse('channel device types', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched',
      dimensions: 'deviceType',
      sort:       '-views',
    })
  );

  const topVideos = await tryParse('channel top videos', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      dimensions: 'video',
      sort:       '-views',
      maxResults: 10,
    })
  );

  // Subscriber report
  const subscribers = await tryParse('channel subscribers over time', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'subscribersGained,subscribersLost',
      dimensions: 'day',
      sort:       'day',
    })
  );

  return { overview, trafficSources, topCountries, deviceTypes, topVideos, subscribers };
}

// ─── 5. Search Queries ────────────────────────────────────────────────────────

async function getSearchQueries(analyticsClient, channelId) {
  console.log('\n🔍 Fetching search query data...');

  const queries = await tryParse('search queries', () =>
    analyticsClient.reports.query({
      ids:        `channel==${channelId}`,
      startDate:  DATE_START,
      endDate:    DATE_END,
      metrics:    'views',
      dimensions: 'insightTrafficSourceDetail',
      filters:    'insightTrafficSourceType==YT_SEARCH',
      sort:       '-views',
      maxResults: 25,
    })
  );

  return queries;
}

// ─── Summarize helpers ────────────────────────────────────────────────────────

function rowsToObjects(report) {
  if (!report || report._error || !report.data?.columnHeaders) return null;
  const headers = report.data.columnHeaders.map(h => h.name);
  const rows    = report.data.rows || [];
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

function sumMetric(report, metricName) {
  const objs = rowsToObjects(report);
  if (!objs) return 'N/A';
  return objs.reduce((acc, r) => acc + (parseFloat(r[metricName]) || 0), 0);
}

function trafficSourceName(code) {
  const MAP = {
    YT_SEARCH:          'YouTube Search',
    SUGGESTED_VIDEOS:   'Suggested Videos',
    SUBSCRIBER:         'Subscriber Feed',
    BROWSE_FEATURES:    'Browse / Home',
    EXTERNAL:           'External / Embedded',
    NOTIFICATION:       'Notification',
    END_SCREEN:         'End Screen',
    PLAYLIST:           'Playlist',
    DIRECT_OR_UNKNOWN:  'Direct / Unknown',
    NO_LINK_EMBEDDED:   'Embedded (No link)',
    SHORT:              'YouTube Shorts Feed',
  };
  return MAP[code] || code;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Rex-Data: Pulling @tinytamiltales channel analytics...\n');
  console.log(`Date range: ${DATE_START} → ${DATE_END}`);

  const oauth2 = getOAuth2Client();
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2 });

  // 1. Channel stats
  const channelRaw = await getChannelStats(youtube);
  const channelId  = channelRaw?.id || 'UNKNOWN';
  console.log(`✅ Channel ID: ${channelId}`);

  // 2. Video stats
  const allVideoIds   = Object.values(VIDEO_IDS);
  const videoStatsRaw = await getVideoStats(youtube, allVideoIds);

  // 3. Per-video analytics
  console.log('\n📈 Fetching per-video analytics...');
  const videoAnalytics = {};
  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    videoAnalytics[label] = await getVideoAnalytics(analytics, channelId, videoId, label);
  }

  // 4. Channel-level analytics
  const channelAnalytics = await getChannelAnalytics(analytics, channelId);

  // 5. Search queries
  const searchQueries = await getSearchQueries(analytics, channelId);

  // ── Assemble full JSON output ─────────────────────────────────────────────
  const fullData = {
    pulledAt:    new Date().toISOString(),
    dateRange:   { start: DATE_START, end: DATE_END },
    channelId,
    videoIds:    VIDEO_IDS,
    channel: {
      raw:       channelRaw,
      analytics: channelAnalytics,
    },
    videos: {
      stats:     videoStatsRaw,
      analytics: videoAnalytics,
    },
    searchQueries,
  };

  const jsonPath = `${DOCS_DIR}/channel-data.json`;
  writeFileSync(jsonPath, JSON.stringify(fullData, null, 2));
  console.log(`\n✅ Full JSON saved → ${jsonPath}`);

  // ── Build readable summary ────────────────────────────────────────────────
  const stats = channelRaw?.statistics || {};
  const videoMap = {};
  if (Array.isArray(videoStatsRaw)) {
    for (const v of videoStatsRaw) videoMap[v.id] = v;
  }

  const lines = [];
  lines.push('# @tinytamiltales Channel Analytics Report');
  lines.push(`\n**Pulled:** ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} IST`);
  lines.push(`**Date range:** ${DATE_START} → ${DATE_END}`);
  lines.push(`**Channel ID:** ${channelId}`);

  lines.push('\n---\n');
  lines.push('## Channel Overview');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Subscribers | ${parseInt(stats.subscriberCount || 0).toLocaleString()} |`);
  lines.push(`| Total Views | ${parseInt(stats.viewCount || 0).toLocaleString()} |`);
  lines.push(`| Total Videos | ${stats.videoCount || 'N/A'} |`);
  lines.push(`| Hidden Sub Count | ${stats.hiddenSubscriberCount ? 'Yes' : 'No'} |`);

  // Channel analytics summary
  const chanOverview = channelAnalytics.overview;
  if (!chanOverview?._error) {
    const totalViews    = sumMetric(chanOverview, 'views');
    const totalMinutes  = sumMetric(chanOverview, 'estimatedMinutesWatched');
    const subGained     = sumMetric(chanOverview, 'subscribersGained');
    const subLost       = sumMetric(chanOverview, 'subscribersLost');
    lines.push(`| Views (period) | ${Math.round(totalViews).toLocaleString()} |`);
    lines.push(`| Watch Time (mins) | ${Math.round(totalMinutes).toLocaleString()} |`);
    lines.push(`| Subs Gained | ${Math.round(subGained)} |`);
    lines.push(`| Subs Lost | ${Math.round(subLost)} |`);
    lines.push(`| Net Subs (period) | ${Math.round(subGained - subLost)} |`);
  }

  // Traffic sources
  const trafficObjs = rowsToObjects(channelAnalytics.trafficSources);
  if (trafficObjs) {
    lines.push('\n## Traffic Sources (Channel)');
    lines.push('| Source | Views | Watch Time (mins) |');
    lines.push('|--------|-------|-------------------|');
    for (const r of trafficObjs) {
      lines.push(`| ${trafficSourceName(r.insightTrafficSourceType)} | ${Math.round(r.views || 0).toLocaleString()} | ${Math.round(r.estimatedMinutesWatched || 0).toLocaleString()} |`);
    }
  }

  // Top countries
  const geoObjs = rowsToObjects(channelAnalytics.topCountries);
  if (geoObjs && geoObjs.length) {
    lines.push('\n## Top Countries');
    lines.push('| Country | Views | Watch Time (mins) |');
    lines.push('|---------|-------|-------------------|');
    for (const r of geoObjs.slice(0, 10)) {
      lines.push(`| ${r.country} | ${Math.round(r.views || 0).toLocaleString()} | ${Math.round(r.estimatedMinutesWatched || 0).toLocaleString()} |`);
    }
  }

  // Device types
  const deviceObjs = rowsToObjects(channelAnalytics.deviceTypes);
  if (deviceObjs) {
    lines.push('\n## Device Types');
    lines.push('| Device | Views | Watch Time (mins) |');
    lines.push('|--------|-------|-------------------|');
    for (const r of deviceObjs) {
      lines.push(`| ${r.deviceType} | ${Math.round(r.views || 0).toLocaleString()} | ${Math.round(r.estimatedMinutesWatched || 0).toLocaleString()} |`);
    }
  }

  lines.push('\n---\n');
  lines.push('## Videos\n');

  for (const [label, videoId] of Object.entries(VIDEO_IDS)) {
    const v   = videoMap[videoId];
    const van = videoAnalytics[label];

    lines.push(`### ${label}: ${v?.title || videoId}`);
    lines.push(`- **ID:** ${videoId}`);
    lines.push(`- **Status:** ${v?.privacyStatus || 'unknown'}`);
    lines.push(`- **Published:** ${v?.publishedAt ? new Date(v.publishedAt).toDateString() : 'N/A'}`);
    lines.push(`- **Duration:** ${v?.durationSec != null ? `${Math.floor(v.durationSec/60)}m ${v.durationSec%60}s` : 'N/A'}`);
    lines.push(`- **Tags:** ${v?.tags?.join(', ') || 'none'}`);

    lines.push('\n**Statistics (YouTube Data API):**');
    lines.push(`| Views | Likes | Comments |`);
    lines.push(`|-------|-------|----------|`);
    lines.push(`| ${(v?.statistics?.viewCount || 0).toLocaleString()} | ${(v?.statistics?.likeCount || 0).toLocaleString()} | ${(v?.statistics?.commentCount || 0).toLocaleString()} |`);

    // Analytics metrics
    const base = van?.base;
    if (base && !base._error) {
      const totalViews     = sumMetric(base, 'views');
      const totalMins      = sumMetric(base, 'estimatedMinutesWatched');
      const rows           = rowsToObjects(base) || [];
      const lastRow        = rows[rows.length - 1];
      const avgViewDur     = lastRow?.averageViewDuration || 'N/A';
      const avgViewPct     = lastRow?.averageViewPercentage || 'N/A';
      const subGained      = sumMetric(base, 'subscribersGained');

      lines.push('\n**Analytics API (period):**');
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Views | ${Math.round(totalViews).toLocaleString()} |`);
      lines.push(`| Watch Time (mins) | ${Math.round(totalMins).toLocaleString()} |`);
      lines.push(`| Avg View Duration | ${typeof avgViewDur === 'number' ? `${Math.floor(avgViewDur/60)}m ${Math.round(avgViewDur%60)}s` : avgViewDur} |`);
      lines.push(`| Avg View % | ${typeof avgViewPct === 'number' ? avgViewPct.toFixed(1) + '%' : avgViewPct} |`);
      lines.push(`| Subs Gained | ${Math.round(subGained)} |`);
    } else if (base?._error) {
      lines.push(`\n_Analytics API error: ${base._error}_`);
    }

    // Traffic sources for this video
    const trafficV = rowsToObjects(van?.traffic);
    if (trafficV && trafficV.length) {
      lines.push('\n**Traffic Sources:**');
      lines.push('| Source | Views |');
      lines.push('|--------|-------|');
      for (const r of trafficV) {
        lines.push(`| ${trafficSourceName(r.insightTrafficSourceType)} | ${Math.round(r.views || 0).toLocaleString()} |`);
      }
    }

    // Geo for this video
    const geoV = rowsToObjects(van?.geo);
    if (geoV && geoV.length) {
      lines.push('\n**Top Countries:**');
      lines.push('| Country | Views |');
      lines.push('|---------|-------|');
      for (const r of geoV.slice(0, 8)) {
        lines.push(`| ${r.country} | ${Math.round(r.views || 0).toLocaleString()} |`);
      }
    }

    lines.push('');
  }

  // Search queries
  const sqObjs = rowsToObjects(searchQueries);
  if (sqObjs && sqObjs.length) {
    lines.push('\n---\n');
    lines.push('## Top YouTube Search Queries');
    lines.push('| Query | Views |');
    lines.push('|-------|-------|');
    for (const r of sqObjs) {
      lines.push(`| ${r.insightTrafficSourceDetail} | ${Math.round(r.views || 0).toLocaleString()} |`);
    }
  } else if (searchQueries?._error) {
    lines.push('\n---\n');
    lines.push('## Search Queries');
    lines.push(`_Not available: ${searchQueries._error}_`);
  }

  lines.push('\n---');
  lines.push(`\n_Report generated by Rex-Data on ${new Date().toISOString()}_`);

  const mdPath = `${DOCS_DIR}/channel-data-summary.md`;
  writeFileSync(mdPath, lines.join('\n'));
  console.log(`✅ Summary saved → ${mdPath}`);

  console.log('\n🎉 Rex-Data done!');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
