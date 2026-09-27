"use strict";

// Public update metadata belongs to this fork. No account credentials are
// required by clients, and a failed request never falls back to the upstream.
const provider = "github";
const name = "GitHub";
const owner = "luojuncheng0327-cell";
const repo = "CAgent";
const repositoryUrl = `https://github.com/${owner}/${repo}`;
const feedUrl = `${repositoryUrl}/releases/latest/download/`;

module.exports = {
  provider,
  name,
  owner,
  repo,
  repositoryUrl,
  feedUrl,
  channelManifestBaseUrl: `${repositoryUrl}/releases/download/channels`,
};
