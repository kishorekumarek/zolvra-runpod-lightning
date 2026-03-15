// lib/youtube.mjs — YouTube Data API v3 wrapper
import { google } from 'googleapis';
import { createReadStream } from 'fs';
import 'dotenv/config';
import { getSetting } from './settings.mjs';

let _youtubeClient = null;

/**
 * Get authenticated YouTube client using stored OAuth tokens.
 */
export async function getYouTubeClient() {
  if (_youtubeClient) return _youtubeClient;

  const clientId     = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth credentials not set (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  _youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client });
  return _youtubeClient;
}

/**
 * Upload a video as Unlisted for human review.
 * Returns the YouTube video ID.
 */
export async function uploadVideoUnlisted({ videoPath, script, taskId }) {
  const youtube = await getYouTubeClient();
  const seo = script.youtube_seo;

  let categoryId = '27'; // Education
  try {
    categoryId = await getSetting('youtube_default_category_id') || '27';
  } catch {}

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title:           seo.title,
        description:     seo.description,
        tags:            seo.tags || [],
        categoryId:      String(categoryId),
        defaultLanguage: 'ta',
      },
      status: {
        privacyStatus:             'unlisted',
        selfDeclaredMadeForKids:   false,
      },
    },
    media: {
      body: createReadStream(videoPath),
    },
  });

  const videoId = res.data.id;
  console.log(`📺 Uploaded to YouTube (unlisted): https://youtu.be/${videoId}`);
  return videoId;
}

/**
 * Publish or schedule an already-uploaded video.
 * Set scheduleAt to a Date object to schedule, or null to publish immediately.
 */
export async function publishVideo({ youtubeVideoId, scheduleAt = null }) {
  const youtube = await getYouTubeClient();

  const status = {
    privacyStatus:           'unlisted',  // Always unlisted — Darl reviews before making public
    selfDeclaredMadeForKids: true,
  };

  if (scheduleAt) {
    status.publishAt = scheduleAt.toISOString();
  }

  await youtube.videos.update({
    part: ['status'],
    requestBody: {
      id: youtubeVideoId,
      status,
    },
  });

  console.log(
    scheduleAt
      ? `📅 Scheduled YouTube video ${youtubeVideoId} for ${scheduleAt.toISOString()}`
      : `🌍 Published YouTube video ${youtubeVideoId} (unlisted — awaiting Darl approval)`
  );
}

/**
 * Add a video to the channel's default playlist.
 */
export async function addToPlaylist({ youtubeVideoId }) {
  const youtube = await getYouTubeClient();

  let playlistId;
  try {
    playlistId = await getSetting('youtube_default_playlist_id');
  } catch {}

  if (!playlistId || playlistId === 'PLACEHOLDER') {
    console.warn('⚠️  youtube_default_playlist_id not set — skipping playlist assignment');
    return;
  }

  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind:    'youtube#video',
          videoId: youtubeVideoId,
        },
      },
    },
  });

  console.log(`📋 Added video ${youtubeVideoId} to playlist ${playlistId}`);
}

/**
 * Get channel info (used in test-connections).
 * Tries mine:true first (works for personal accounts),
 * then falls back to handle lookup for Brand Accounts.
 */
export async function getChannelInfo() {
  const youtube = await getYouTubeClient();

  // Try mine:true first
  let res = await youtube.channels.list({
    part: ['snippet', 'statistics'],
    mine: true,
  });

  if (res.data?.items?.length > 0) {
    return res.data.items[0];
  }

  // Brand Account fallback — look up by handle
  res = await youtube.channels.list({
    part: ['snippet', 'statistics'],
    forHandle: 'tinytamiltales',
  });

  return res.data?.items?.[0] || null;
}
