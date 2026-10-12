const INHERITED_GIT_STATE = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_DATE",
];

for (const name of INHERITED_GIT_STATE) delete process.env[name];

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "T";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "T";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";
