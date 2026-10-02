# Kerb Execution Record (KER) v1

Kerb records what actually ran in an append-only event log, `.kerb/runs.jsonl` (one JSON object per line, each ending with a `crc` field). This page is the published format ([KERB-V2](KERB-V2.md) 5.1). Memory tools, dashboards and research can read the log directly; `kerb query` and `kerb export` return the same records.

**Stability.** Within KER v1, changes are additive only: new record types and new optional fields. Readers must ignore fields and record types they don't know. Every record has a `type`. Timestamps (`ts`) are milliseconds since the Unix epoch. State ids look like `st_` and 16 hex digits.

**Derived files.** `.kerb/index/*.json` are indexes rebuilt from the log at any time (`kerb reindex`); they are not part of the format.

| Type | Where | What it is |
|---|---|---|
| `session` | event log | An agent session, written when its first record arrives. |
| `state` | event log | A kept state: the content of a check command's scope plus its environment stamp (4.1, 4.2). |
| `start` | event log | A run began (v1 4.9). Joined with its `end` into a `run`. |
| `end` | event log | A run finished (v1 4.9). |
| `wait` | event log | A `kerb wait-for` call: many attempts, counted as one run (v1 4.7.8). |
| `run` | derived | A finished command: a `start` and its `end` (or a `wait`), as `kerb query` and `kerb export` return it. |
| `test_result` | event log | One test (or diagnostic) in a run (5.3, 5.4). |
| `refusal` | event log | Kerb refused a command. |
| `would_refuse` | event log | In shadow mode: a refusal Kerb recorded instead of making (10.2). |
| `cached_answer` | event log | A check answered from a recorded run on the same state (6.3). |
| `fix` | event log | A change that turned a failure green (7.6). |
| `finding` | event log | A cause isolated by the worker (8.2). |
| `learn` | event log | A wall learned from a policy denial (v1 4.8.5). |
| `boundary` | learned store | A learned boundary entry, as kept in ~/.kerb/learned.jsonl (v1 4.8.5). |
| `note` | event log | Advisory text from Kerb or a plugin. |
| `ack` | event log | A human allowed one more run of a key (v1 4.7.7). |
| `reset` | event log | A human cleared loop state for a key, or all keys (v1 4.7.7). |

## `session`

An agent session, written when its first record arrives.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/session.schema.json",
  "title": "KER v1 session",
  "description": "An agent session, written when its first record arrives. Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts"
  ],
  "properties": {
    "type": {
      "const": "session"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "agent": {
      "type": [
        "string",
        "null"
      ]
    },
    "tier": {
      "type": [
        "string",
        "null"
      ]
    },
    "started": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "branch": {
      "type": [
        "string",
        "null"
      ]
    },
    "mode": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "shadow",
        "enforce",
        null
      ]
    }
  }
}
```

## `state`

A kept state: the content of a check command's scope plus its environment stamp (4.1, 4.2).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/state.schema.json",
  "title": "KER v1 state",
  "description": "A kept state: the content of a check command's scope plus its environment stamp (4.1, 4.2). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "mode",
    "materializable"
  ],
  "properties": {
    "type": {
      "const": "state"
    },
    "id": {
      "type": "string",
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "mode": {
      "type": "string",
      "enum": [
        "git",
        "walk"
      ]
    },
    "scope": {
      "type": "string"
    },
    "snapshot_tree": {
      "type": [
        "string",
        "null"
      ]
    },
    "commit": {
      "type": [
        "string",
        "null"
      ]
    },
    "env_stamp": {
      "type": [
        "string",
        "null"
      ]
    },
    "materializable": {
      "type": "boolean"
    }
  }
}
```

## `start`

A run began (v1 4.9). Joined with its `end` into a `run`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/start.schema.json",
  "title": "KER v1 start",
  "description": "A run began (v1 4.9). Joined with its `end` into a `run`. Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key",
    "class"
  ],
  "properties": {
    "type": {
      "const": "start"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "class": {
      "type": "string",
      "enum": [
        "check",
        "query",
        "other",
        "background"
      ]
    },
    "cmd": {
      "type": "string"
    },
    "cwd": {
      "type": "string"
    },
    "scope": {
      "type": [
        "string",
        "null"
      ]
    },
    "pre_hash": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "env_stamp": {
      "type": [
        "string",
        "null"
      ]
    },
    "kerb_pid": {
      "type": [
        "integer",
        "null"
      ]
    },
    "pgid": {
      "type": [
        "integer",
        "null"
      ]
    },
    "agent": {
      "type": [
        "string",
        "null"
      ]
    },
    "tier": {
      "type": [
        "string",
        "null"
      ]
    },
    "session": {
      "type": [
        "string",
        "null"
      ]
    },
    "mode": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "shadow",
        "enforce",
        null
      ]
    }
  }
}
```

## `end`

A run finished (v1 4.9).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/end.schema.json",
  "title": "KER v1 end",
  "description": "A run finished (v1 4.9). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts"
  ],
  "properties": {
    "type": {
      "const": "end"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "exit": {
      "type": [
        "integer",
        "null"
      ]
    },
    "signal": {
      "type": [
        "string",
        "null"
      ]
    },
    "duration_ms": {
      "type": [
        "number",
        "null"
      ]
    },
    "post_hash": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "fingerprint": {
      "type": [
        "string",
        "null"
      ]
    },
    "failure_kind": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "transient",
        "dependency",
        "environment",
        "ordinary",
        null
      ]
    },
    "env_subtype": {
      "type": [
        "string",
        "null"
      ]
    },
    "class_result": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "ok",
        "failure",
        "policy_denial",
        "timeout",
        "idle",
        "aborted",
        null
      ]
    },
    "raw_bytes": {
      "type": [
        "integer",
        "null"
      ]
    },
    "shown_bytes": {
      "type": [
        "integer",
        "null"
      ]
    },
    "first_fail_line": {
      "type": [
        "string",
        "null"
      ]
    },
    "loop_skipped": {
      "type": [
        "string",
        "null"
      ]
    },
    "key": {
      "type": "string"
    },
    "class": {
      "type": "string",
      "enum": [
        "check",
        "query",
        "other",
        "background"
      ]
    },
    "session": {
      "type": [
        "string",
        "null"
      ]
    },
    "framework": {
      "type": [
        "string",
        "null"
      ]
    },
    "tests_summary": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

## `wait`

A `kerb wait-for` call: many attempts, counted as one run (v1 4.7.8).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/wait.schema.json",
  "title": "KER v1 wait",
  "description": "A `kerb wait-for` call: many attempts, counted as one run (v1 4.7.8). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key",
    "attempts",
    "result"
  ],
  "properties": {
    "type": {
      "const": "wait"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "attempts": {
      "type": "integer"
    },
    "duration_ms": {
      "type": [
        "number",
        "null"
      ]
    },
    "result": {
      "type": "string",
      "enum": [
        "met",
        "gave_up",
        "aborted"
      ]
    },
    "final_exit": {
      "type": [
        "integer",
        "null"
      ]
    },
    "pre_hash": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "post_hash": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "session": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

## `run`

A finished command: a `start` and its `end` (or a `wait`), as `kerb query` and `kerb export` return it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/run.schema.json",
  "title": "KER v1 run",
  "description": "A finished command: a `start` and its `end` (or a `wait`), as `kerb query` and `kerb export` return it. Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "key",
    "class"
  ],
  "properties": {
    "type": {
      "const": "run"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "session": {
      "type": [
        "string",
        "null"
      ]
    },
    "cmd": {
      "type": "string"
    },
    "first_fail_line": {
      "type": [
        "string",
        "null"
      ]
    },
    "key": {
      "type": "string"
    },
    "class": {
      "type": "string",
      "enum": [
        "check",
        "query",
        "other",
        "background"
      ]
    },
    "scope": {
      "type": [
        "string",
        "null"
      ]
    },
    "pre_state": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "post_state": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    },
    "exit": {
      "type": [
        "integer",
        "null"
      ]
    },
    "duration_ms": {
      "type": [
        "number",
        "null"
      ]
    },
    "fingerprint": {
      "type": [
        "string",
        "null"
      ]
    },
    "failure_kind": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "transient",
        "dependency",
        "environment",
        "ordinary",
        null
      ]
    },
    "class_result": {
      "type": [
        "string",
        "null"
      ],
      "enum": [
        "ok",
        "failure",
        "policy_denial",
        "timeout",
        "idle",
        "aborted",
        null
      ]
    },
    "raw_bytes": {
      "type": [
        "integer",
        "null"
      ]
    },
    "shown_bytes": {
      "type": [
        "integer",
        "null"
      ]
    },
    "framework": {
      "type": [
        "string",
        "null"
      ]
    },
    "tests_summary": {
      "type": [
        "object",
        "null"
      ],
      "properties": {
        "passed": {
          "type": "integer"
        },
        "failed": {
          "type": "integer"
        },
        "skipped": {
          "type": "integer"
        },
        "errors": {
          "type": "integer"
        },
        "total": {
          "type": "integer"
        }
      }
    }
  }
}
```

## `test_result`

One test (or diagnostic) in a run (5.3, 5.4).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/test_result.schema.json",
  "title": "KER v1 test_result",
  "description": "One test (or diagnostic) in a run (5.3, 5.4). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "run",
    "test_id",
    "status"
  ],
  "properties": {
    "type": {
      "const": "test_result"
    },
    "run": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "test_id": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "pass",
        "fail",
        "skip",
        "error"
      ]
    },
    "location": {
      "type": [
        "string",
        "null"
      ]
    },
    "message": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "duration_ms": {
      "type": [
        "number",
        "null"
      ]
    },
    "key": {
      "type": "string"
    },
    "state": {
      "type": [
        "string",
        "null"
      ],
      "description": "a state id (v2) or a v1 workspace hash"
    }
  }
}
```

## `refusal`

Kerb refused a command.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/refusal.schema.json",
  "title": "KER v1 refusal",
  "description": "Kerb refused a command. Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key",
    "reason"
  ],
  "properties": {
    "type": {
      "const": "refusal"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "reason": {
      "type": "string"
    },
    "matched_run": {
      "type": [
        "string",
        "null"
      ]
    },
    "avoided_duration_ms": {
      "type": "number",
      "minimum": 0
    },
    "avoided_output_bytes": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

## `would_refuse`

In shadow mode: a refusal Kerb recorded instead of making (10.2).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/would_refuse.schema.json",
  "title": "KER v1 would_refuse",
  "description": "In shadow mode: a refusal Kerb recorded instead of making (10.2). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key",
    "reason"
  ],
  "properties": {
    "type": {
      "const": "would_refuse"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "reason": {
      "type": "string"
    },
    "matched_run": {
      "type": [
        "string",
        "null"
      ]
    },
    "avoided_duration_ms": {
      "type": "number",
      "minimum": 0
    },
    "avoided_output_bytes": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

## `cached_answer`

A check answered from a recorded run on the same state (6.3).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/cached_answer.schema.json",
  "title": "KER v1 cached_answer",
  "description": "A check answered from a recorded run on the same state (6.3). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key",
    "state",
    "source_run"
  ],
  "properties": {
    "type": {
      "const": "cached_answer"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "state": {
      "type": "string",
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "source_run": {
      "type": "string"
    }
  }
}
```

## `fix`

A change that turned a failure green (7.6).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/fix.schema.json",
  "title": "KER v1 fix",
  "description": "A change that turned a failure green (7.6). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "fingerprint",
    "confidence"
  ],
  "properties": {
    "type": {
      "const": "fix"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": [
        "string",
        "null"
      ]
    },
    "fingerprint": {
      "type": "string"
    },
    "family": {
      "type": [
        "string",
        "null"
      ]
    },
    "test_ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "from_state": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "to_state": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "hunks": {
      "type": [
        "array",
        "null"
      ]
    },
    "commit": {
      "type": [
        "string",
        "null"
      ]
    },
    "confidence": {
      "type": "string",
      "enum": [
        "minimal",
        "full diff",
        "shared"
      ]
    },
    "shared": {
      "type": "boolean"
    }
  }
}
```

## `finding`

A cause isolated by the worker (8.2).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/finding.schema.json",
  "title": "KER v1 finding",
  "description": "A cause isolated by the worker (8.2). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "kind",
    "test_id",
    "confidence"
  ],
  "properties": {
    "type": {
      "const": "finding"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "kind": {
      "const": "cause"
    },
    "key": {
      "type": [
        "string",
        "null"
      ]
    },
    "test_id": {
      "type": "string"
    },
    "good_state": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "bad_state": {
      "type": [
        "string",
        "null"
      ],
      "pattern": "^st_[0-9a-f]{16}$"
    },
    "culprit_hunks": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "locations": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "hunk_count": {
      "type": "integer"
    },
    "probes": {
      "type": "integer"
    },
    "confidence": {
      "type": "string",
      "enum": [
        "confirmed",
        "undetermined"
      ]
    },
    "reason_if_undetermined": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

## `learn`

A wall learned from a policy denial (v1 4.8.5).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/learn.schema.json",
  "title": "KER v1 learn",
  "description": "A wall learned from a policy denial (v1 4.8.5). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "host",
    "status"
  ],
  "properties": {
    "type": {
      "const": "learn"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "host": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "confirmed",
        "suspected"
      ]
    },
    "run": {
      "type": [
        "string",
        "null"
      ]
    },
    "session": {
      "type": [
        "string",
        "null"
      ]
    },
    "new": {
      "type": "boolean"
    }
  }
}
```

## `boundary`

A learned boundary entry, as kept in ~/.kerb/learned.jsonl (v1 4.8.5).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/boundary.schema.json",
  "title": "KER v1 boundary",
  "description": "A learned boundary entry, as kept in ~/.kerb/learned.jsonl (v1 4.8.5). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "kind",
    "pattern",
    "status"
  ],
  "properties": {
    "type": {
      "const": "boundary"
    },
    "kind": {
      "const": "host"
    },
    "pattern": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "confirmed",
        "suspected"
      ]
    },
    "first_seen": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "last_seen": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "hits": {
      "type": "integer"
    },
    "keys": {
      "type": "array"
    },
    "evidence_run": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

## `note`

Advisory text from Kerb or a plugin.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/note.schema.json",
  "title": "KER v1 note",
  "description": "Advisory text from Kerb or a plugin. Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "source",
    "text"
  ],
  "properties": {
    "type": {
      "const": "note"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "source": {
      "type": "string"
    },
    "text": {
      "type": "string"
    },
    "level": {
      "type": "string",
      "enum": [
        "info",
        "warn"
      ]
    }
  }
}
```

## `ack`

A human allowed one more run of a key (v1 4.7.7).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/ack.schema.json",
  "title": "KER v1 ack",
  "description": "A human allowed one more run of a key (v1 4.7.7). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts",
    "key"
  ],
  "properties": {
    "type": {
      "const": "ack"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": "string"
    },
    "fingerprint": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

## `reset`

A human cleared loop state for a key, or all keys (v1 4.7.7).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/reset.schema.json",
  "title": "KER v1 reset",
  "description": "A human cleared loop state for a key, or all keys (v1 4.7.7). Readers must ignore fields they don't know; within KER v1 changes are additive only.",
  "type": "object",
  "required": [
    "type",
    "id",
    "ts"
  ],
  "properties": {
    "type": {
      "const": "reset"
    },
    "id": {
      "type": "string"
    },
    "ts": {
      "type": "integer",
      "minimum": 0,
      "description": "milliseconds since the Unix epoch"
    },
    "key": {
      "type": [
        "string",
        "null"
      ]
    }
  }
}
```

## Query results

`kerb query <name>` prints one JSON object (KERB-V2 11.1); the MCP server's tools return the same shapes in `structuredContent`. `kerb export --format ker` writes the records above as NDJSON: runs as `run` records (never `start`, `end` or `wait`), without `crc`, with text redacted again; `--no-text` keeps only ids, counts, codes and hashes (keys, test ids and patterns become `h:` and 16 hex digits).

### `kerb query runs`

Finished runs, newest first, as KER `run` records.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.runs.schema.json",
  "title": "kerb query runs",
  "description": "Finished runs, newest first, as KER `run` records. Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "runs"
  ],
  "properties": {
    "query": {
      "const": "runs"
    },
    "runs": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "id",
          "key",
          "class"
        ],
        "properties": {
          "type": {
            "const": "run"
          },
          "id": {
            "type": "string"
          },
          "ts": {
            "type": "integer",
            "minimum": 0,
            "description": "milliseconds since the Unix epoch"
          },
          "session": {
            "type": [
              "string",
              "null"
            ]
          },
          "cmd": {
            "type": "string"
          },
          "first_fail_line": {
            "type": [
              "string",
              "null"
            ]
          },
          "key": {
            "type": "string"
          },
          "class": {
            "type": "string",
            "enum": [
              "check",
              "query",
              "other",
              "background"
            ]
          },
          "scope": {
            "type": [
              "string",
              "null"
            ]
          },
          "pre_state": {
            "type": [
              "string",
              "null"
            ],
            "description": "a state id (v2) or a v1 workspace hash"
          },
          "post_state": {
            "type": [
              "string",
              "null"
            ],
            "description": "a state id (v2) or a v1 workspace hash"
          },
          "exit": {
            "type": [
              "integer",
              "null"
            ]
          },
          "duration_ms": {
            "type": [
              "number",
              "null"
            ]
          },
          "fingerprint": {
            "type": [
              "string",
              "null"
            ]
          },
          "failure_kind": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "transient",
              "dependency",
              "environment",
              "ordinary",
              null
            ]
          },
          "class_result": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "ok",
              "failure",
              "policy_denial",
              "timeout",
              "idle",
              "aborted",
              null
            ]
          },
          "raw_bytes": {
            "type": [
              "integer",
              "null"
            ]
          },
          "shown_bytes": {
            "type": [
              "integer",
              "null"
            ]
          },
          "framework": {
            "type": [
              "string",
              "null"
            ]
          },
          "tests_summary": {
            "type": [
              "object",
              "null"
            ],
            "properties": {
              "passed": {
                "type": "integer"
              },
              "failed": {
                "type": "integer"
              },
              "skipped": {
                "type": "integer"
              },
              "errors": {
                "type": "integer"
              },
              "total": {
                "type": "integer"
              }
            }
          }
        }
      }
    }
  }
}
```

### `kerb query tests`

One entry per test id seen in the window: its latest status, flaky when it both passed and failed on one state.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.tests.schema.json",
  "title": "kerb query tests",
  "description": "One entry per test id seen in the window: its latest status, flaky when it both passed and failed on one state. Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "tests"
  ],
  "properties": {
    "query": {
      "const": "tests"
    },
    "tests": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "test_id",
          "status",
          "last_run"
        ],
        "properties": {
          "test_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "failing",
              "flaky",
              "passing",
              "skipped"
            ]
          },
          "key": {
            "type": [
              "string",
              "null"
            ]
          },
          "last_run": {
            "type": "string"
          },
          "last_state": {
            "type": [
              "string",
              "null"
            ],
            "description": "a state id (v2) or a v1 workspace hash"
          },
          "last_ts": {
            "type": [
              "integer",
              "null"
            ]
          },
          "runs": {
            "type": "integer"
          },
          "failures": {
            "type": "integer"
          },
          "message": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200
          }
        }
      }
    }
  }
}
```

### `kerb query verification`

Is each tracked check key's last result about the files as they are now (7.2)?

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.verification.schema.json",
  "title": "kerb query verification",
  "description": "Is each tracked check key's last result about the files as they are now (7.2)? Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "keys"
  ],
  "properties": {
    "query": {
      "const": "verification"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "key",
          "command",
          "status"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "command": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "green",
              "red",
              "stale",
              "never",
              "unknown"
            ]
          },
          "run": {
            "type": [
              "string",
              "null"
            ]
          },
          "ts": {
            "type": [
              "integer",
              "null"
            ]
          },
          "files": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "last_green": {
            "type": [
              "object",
              "null"
            ],
            "properties": {
              "run": {
                "type": "string"
              },
              "ts": {
                "type": "integer",
                "minimum": 0,
                "description": "milliseconds since the Unix epoch"
              },
              "files": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### `kerb query progress`

Failing counts per check key since its last success, and the signal (7.3).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.progress.schema.json",
  "title": "kerb query progress",
  "description": "Failing counts per check key since its last success, and the signal (7.3). Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "keys"
  ],
  "properties": {
    "query": {
      "const": "progress"
    },
    "keys": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "key",
          "command",
          "counts",
          "signal",
          "runs"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "command": {
            "type": "string"
          },
          "counts": {
            "type": "array",
            "items": {
              "type": [
                "integer",
                "null"
              ]
            }
          },
          "signal": {
            "type": [
              "string",
              "null"
            ],
            "enum": [
              "green",
              "oscillating",
              "stalled",
              "diverging",
              "converging",
              null
            ]
          },
          "runs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    }
  }
}
```

### `kerb query fixes`

Proven fixes, newest first, as KER `fix` records (the latest version of each).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.fixes.schema.json",
  "title": "kerb query fixes",
  "description": "Proven fixes, newest first, as KER `fix` records (the latest version of each). Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "fixes"
  ],
  "properties": {
    "query": {
      "const": "fixes"
    },
    "fixes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "id",
          "fingerprint",
          "confidence"
        ],
        "properties": {
          "type": {
            "const": "fix"
          },
          "id": {
            "type": "string"
          },
          "ts": {
            "type": "integer",
            "minimum": 0,
            "description": "milliseconds since the Unix epoch"
          },
          "key": {
            "type": [
              "string",
              "null"
            ]
          },
          "fingerprint": {
            "type": "string"
          },
          "family": {
            "type": [
              "string",
              "null"
            ]
          },
          "test_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "from_state": {
            "type": [
              "string",
              "null"
            ],
            "pattern": "^st_[0-9a-f]{16}$"
          },
          "to_state": {
            "type": [
              "string",
              "null"
            ],
            "pattern": "^st_[0-9a-f]{16}$"
          },
          "hunks": {
            "type": [
              "array",
              "null"
            ]
          },
          "commit": {
            "type": [
              "string",
              "null"
            ]
          },
          "confidence": {
            "type": "string",
            "enum": [
              "minimal",
              "full diff",
              "shared"
            ]
          },
          "shared": {
            "type": "boolean"
          }
        }
      }
    }
  }
}
```

### `kerb query findings`

Cause findings, newest first, as KER `finding` records.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.findings.schema.json",
  "title": "kerb query findings",
  "description": "Cause findings, newest first, as KER `finding` records. Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "findings"
  ],
  "properties": {
    "query": {
      "const": "findings"
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "id",
          "kind",
          "test_id",
          "confidence"
        ],
        "properties": {
          "type": {
            "const": "finding"
          },
          "id": {
            "type": "string"
          },
          "ts": {
            "type": "integer",
            "minimum": 0,
            "description": "milliseconds since the Unix epoch"
          },
          "kind": {
            "const": "cause"
          },
          "key": {
            "type": [
              "string",
              "null"
            ]
          },
          "test_id": {
            "type": "string"
          },
          "good_state": {
            "type": [
              "string",
              "null"
            ],
            "pattern": "^st_[0-9a-f]{16}$"
          },
          "bad_state": {
            "type": [
              "string",
              "null"
            ],
            "pattern": "^st_[0-9a-f]{16}$"
          },
          "culprit_hunks": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "locations": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "hunk_count": {
            "type": "integer"
          },
          "probes": {
            "type": "integer"
          },
          "confidence": {
            "type": "string",
            "enum": [
              "confirmed",
              "undetermined"
            ]
          },
          "reason_if_undetermined": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      }
    }
  }
}
```

### `kerb query states`

Kept states of check runs, newest first: the KER `state` fields plus the run, key and whether it passed.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/query.states.schema.json",
  "title": "kerb query states",
  "description": "Kept states of check runs, newest first: the KER `state` fields plus the run, key and whether it passed. Readers must ignore fields they don't know.",
  "type": "object",
  "required": [
    "query",
    "states"
  ],
  "properties": {
    "query": {
      "const": "states"
    },
    "states": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "id",
          "ts",
          "mode",
          "materializable"
        ],
        "properties": {
          "type": {
            "const": "state"
          },
          "id": {
            "type": "string",
            "pattern": "^st_[0-9a-f]{16}$"
          },
          "ts": {
            "type": "integer",
            "minimum": 0,
            "description": "milliseconds since the Unix epoch"
          },
          "mode": {
            "type": "string",
            "enum": [
              "git",
              "walk"
            ]
          },
          "scope": {
            "type": "string"
          },
          "snapshot_tree": {
            "type": [
              "string",
              "null"
            ]
          },
          "commit": {
            "type": [
              "string",
              "null"
            ]
          },
          "env_stamp": {
            "type": [
              "string",
              "null"
            ]
          },
          "materializable": {
            "type": "boolean"
          },
          "key": {
            "type": "string"
          },
          "run": {
            "type": "string"
          },
          "green": {
            "type": "boolean"
          }
        }
      }
    }
  }
}
```
