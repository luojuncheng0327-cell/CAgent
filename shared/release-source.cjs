"use strict";

// Public update metadata belongs to this fork. No account credentials are
// required by clients, and a failed request never falls back to the upstream.
const owner = "luo-juncheng666";
const repo = "cagent";
const repositoryUrl = `https://gitee.com/${owner}/${repo}`;
const feedUrl = `${repositoryUrl}/raw/master/updates/`;

module.exports = {
  owner,
  repo,
  repositoryUrl,
  feedUrl,
  channelManifestBaseUrl: `${feedUrl}channels`,
};
