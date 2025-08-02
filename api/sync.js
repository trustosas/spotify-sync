// api/sync.js - Vercel serverless function
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';

// Helper function to get access token
async function getAccessToken(code) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    })
  });
  
  return await response.json();
}

// Helper function to refresh access token
async function refreshAccessToken(refreshToken) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  
  return await response.json();
}

// Get user's liked songs
async function getLikedSongs(accessToken) {
  let allTracks = [];
  let url = 'https://api.spotify.com/v1/me/tracks?limit=50';
  
  while (url) {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch liked songs: ${response.statusText}`);
    }
    
    const data = await response.json();
    allTracks = allTracks.concat(data.items);
    url = data.next;
  }
  
  return allTracks.map(item => item.track.id);
}

// Add songs to user's liked songs
async function addLikedSongs(accessToken, trackIds) {
  const batchSize = 50; // Spotify API limit
  const results = [];
  
  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    
    const response = await fetch('https://api.spotify.com/v1/me/tracks', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ids: batch
      })
    });
    
    if (!response.ok) {
      console.error(`Failed to add batch ${i / batchSize + 1}: ${response.statusText}`);
    } else {
      results.push(batch.length);
    }
    
    // Rate limiting - wait 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return results;
}

// Main sync function
async function syncLikedSongs(sourceToken, targetToken) {
  try {
    // Get liked songs from source account
    console.log('Fetching liked songs from source account...');
    const sourceTracks = await getLikedSongs(sourceToken);
    console.log(`Found ${sourceTracks.length} liked songs in source account`);
    
    // Get existing liked songs from target account
    console.log('Fetching existing liked songs from target account...');
    const targetTracks = await getLikedSongs(targetToken);
    console.log(`Found ${targetTracks.length} liked songs in target account`);
    
    // Find songs that need to be added (exist in source but not in target)
    const tracksToAdd = sourceTracks.filter(trackId => !targetTracks.includes(trackId));
    console.log(`Need to add ${tracksToAdd.length} new songs`);
    
    if (tracksToAdd.length === 0) {
      return { message: 'Accounts are already in sync!', added: 0 };
    }
    
    // Add missing songs to target account
    console.log('Adding songs to target account...');
    const results = await addLikedSongs(targetToken, tracksToAdd);
    const totalAdded = results.reduce((sum, count) => sum + count, 0);
    
    return {
      message: 'Sync completed successfully!',
      added: totalAdded,
      sourceSongs: sourceTracks.length,
      targetSongs: targetTracks.length + totalAdded
    };
    
  } catch (error) {
    console.error('Sync error:', error);
    throw error;
  }
}

// Vercel serverless function handler
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method === 'POST') {
    try {
      const { sourceCode, targetCode, sourceRefreshToken, targetRefreshToken } = req.body;
      
      let sourceToken, targetToken;
      
      // Get access tokens
      if (sourceCode) {
        const sourceTokenData = await getAccessToken(sourceCode);
        sourceToken = sourceTokenData.access_token;
      } else if (sourceRefreshToken) {
        const sourceTokenData = await refreshAccessToken(sourceRefreshToken);
        sourceToken = sourceTokenData.access_token;
      }
      
      if (targetCode) {
        const targetTokenData = await getAccessToken(targetCode);
        targetToken = targetTokenData.access_token;
      } else if (targetRefreshToken) {
        const targetTokenData = await refreshAccessToken(targetRefreshToken);
        targetToken = targetTokenData.access_token;
      }
      
      if (!sourceToken || !targetToken) {
        return res.status(400).json({ error: 'Missing access tokens' });
      }
      
      // Perform sync
      const result = await syncLikedSongs(sourceToken, targetToken);
      
      return res.status(200).json(result);
      
    } catch (error) {
      console.error('Handler error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
  
  // GET request - return authorization URLs
  if (req.method === 'GET') {
    const scopes = 'user-library-read user-library-modify';
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    
    return res.status(200).json({
      authUrl,
      message: 'Use this URL to authorize both accounts'
    });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}