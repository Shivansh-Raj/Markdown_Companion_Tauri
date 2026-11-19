/**
 * Obsidian Bases dashboards over the properties MC writes when you export a voice session in Obsidian format.
 * A `.base` file is YAML (https://obsidian.md/help/bases/syntax). These files only read notes; MC does not need
 * Obsidian to write them, and Obsidian does all the rendering.
 *
 * No `sort` is written: the docs do not document a sort key for a view. MC's export file names start with the
 * date, so Obsidian's default name order is already chronological, and any column can be sorted in Obsidian.
 */

export const DASHBOARD_FOLDER = "MC Dashboards";

export interface DashboardFile {
  /** File name, e.g. "Meetings.base". */
  name: string;
  /** One line for the install dialog. */
  summary: string;
  content: string;
}

const FROM_MC = `    - 'source == "markdown-companion"'`;

export function dashboardFiles(): DashboardFile[] {
  return [
    {
      name: "Meetings.base",
      summary: "Every meeting exported from MC: date, length and tags.",
      content: `filters:
  and:
${FROM_MC}
    - 'type == "meeting"'
properties:
  date:
    displayName: Date
  duration_min:
    displayName: Minutes
  kind:
    displayName: Export
views:
  - type: table
    name: Meetings
    order:
      - file.name
      - date
      - duration_min
      - kind
      - tags
`,
    },
    {
      name: "Speaking practice.base",
      summary: "Practice sessions with pace, filler words and long pauses, to see progress over time.",
      content: `filters:
  and:
${FROM_MC}
    - 'type == "practice"'
properties:
  date:
    displayName: Date
  duration_min:
    displayName: Minutes
  pace_wpm:
    displayName: Words per minute
  speaking_wpm:
    displayName: Speaking pace
  filler_count:
    displayName: Fillers
  fillers_per_100_words:
    displayName: Fillers per 100 words
  long_pauses:
    displayName: Long pauses
views:
  - type: table
    name: Practice sessions
    order:
      - file.name
      - date
      - duration_min
      - words
      - pace_wpm
      - speaking_wpm
      - filler_count
      - fillers_per_100_words
      - long_pauses
`,
    },
    {
      name: "All voice sessions.base",
      summary: "Everything MC exported from the Voice workspace, meetings, practice and quick notes together.",
      content: `filters:
  and:
${FROM_MC}
    - file.hasTag("voice")
properties:
  type:
    displayName: Type
  date:
    displayName: Date
  duration_min:
    displayName: Minutes
views:
  - type: table
    name: Voice sessions
    order:
      - file.name
      - type
      - date
      - duration_min
      - kind
`,
    },
  ];
}
