# TGS Game Tracker 🏎️

Discord bot for tracking racing-game tournaments, players, races, tracks and points.

## Current commands

- `/help` — show commands
- `/tournament name:` — create a tournament
- `/player name: discord:` — add a player
- `/race tournament: number: track: results:` — record a race
- `/stats player:` — player totals
- `/tournament-stats tournament:` — tournament leaderboard
- `/player-history player:` — recent race history

### Race results format

`Player1=25,Player2=18,Player3=15`

Players can be created automatically when recording a race.

## Run on a VPS

Requirements: Node.js 20+.

1. Copy `.env.example` to `.env`.
2. Put your Discord bot token, application/client ID and server/guild ID in `.env`.
3. Run `npm install`.
4. Run `npm run build`.
5. Run `npm start`.

The SQLite database is stored at `./data/tgs-tracker.db` by default. Keep the `data` folder persistent when deploying.

Never commit `.env` or your bot token.
