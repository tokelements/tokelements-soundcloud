# TokElements for SoundCloud

**Put the track you are playing on your TikTok LIVE overlay, and let your viewers drop the next one into Next up.**

[![Install the script](https://img.shields.io/badge/Install-the%20script-FF5500?style=for-the-badge)](https://raw.githubusercontent.com/tokelements/tokelements-soundcloud/main/tokelements-soundcloud.user.js)
[![TokElements](https://img.shields.io/badge/TokElements-tokelements.com-FF3158?style=for-the-badge)](https://tokelements.com)

[![Version](https://img.shields.io/badge/version-0.2.3-22232D?style=flat-square)](tokelements-soundcloud.user.js)
[![License](https://img.shields.io/badge/license-MIT-22232D?style=flat-square)](LICENSE)
[![Works with](https://img.shields.io/badge/works%20with-OBS%20·%20Streamlabs%20·%20TikTok%20LIVE%20Studio-22232D?style=flat-square)](https://tokelements.com)

This is a userscript for [**TokElements**](https://tokelements.com), the live streaming tool that turns
a TikTok LIVE broadcast into overlays for OBS. It reads the SoundCloud player you already have open
and sends the current track to your overlay, so a now playing widget can show it on stream. In the
other direction it takes song requests from your viewers and puts them in your Next up.

There is no SoundCloud app to register, no client id, no OAuth screen and no password. The script
works with the session you are already logged into, in your own browser. A free SoundCloud account is
enough — unlike Spotify, SoundCloud does not put its queue behind a subscription.

---

## What you get on stream

- **A now playing widget with a real waveform** — the bars fill as the track plays, drawn from the
  title so the same song always looks the same. A card with artwork, or a slim lower-third bar.
- **A Next up widget** — what is playing and what is queued behind it, numbered the way SoundCloud
  numbers it, read straight out of the player.
- **Viewer song requests** — a chat command like `!song bad guy` costs the viewer loyalty points and
  puts the track in Next up, right behind what is playing, exactly where SoundCloud's own
  **Add to Next up** puts it. The pending list shows on your overlay with artwork and who asked.
- **A skip command** — priced in points, so skipping the current track is something viewers spend on
  rather than something they spam.

Every widget is editable HTML, CSS and JavaScript in the TokElements editor.

## How it works

SoundCloud keeps its queue in the page rather than on a server, so reading what is playing and adding
a track has to happen inside the tab.

**Your browser** runs this script on `soundcloud.com`. It injects a small piece of code into the page,
finds the player's own controller through the site's module runtime, and uses it for four things:
read the current track, read the queue, run a transport command, add a track to Next up. It finds
that controller by what it can do, never by an internal name or number — SoundCloud renumbers those
on every release. If it ever cannot find it, the script falls back to reading the player bar at the
bottom of the page, so the overlay keeps showing the track even when requests stop working. The
status panel in the corner says which of the two is running.

**TokElements** holds the track in memory for a minute at a time and hands it to the widgets on your
overlay. Nothing about it is written to a database.

**Your overlay** is a single browser source in OBS. The widgets on it subscribe to the track and
render it however you designed them.

## Install

**1. Get a userscript manager.** Tampermonkey is the one this is tested against.

| Browser | Get Tampermonkey |
| --- | --- |
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Opera | [Opera Add-ons](https://addons.opera.com/en/extensions/details/tampermonkey-beta/) |
| Safari | [Mac App Store](https://apps.apple.com/us/app/tampermonkey-classic/id1482490089?mt=12) |

**2. [Install the script](https://raw.githubusercontent.com/tokelements/tokelements-soundcloud/main/tokelements-soundcloud.user.js).**
Tampermonkey opens its own install screen. Nothing lands in your browser until you confirm there.

**3. Open `soundcloud.com`** in the same browser and log in.

**4. Open the SoundCloud page in your TokElements studio** and press
**Connect SoundCloud in this browser**. The script picks the pairing up by itself — there is nothing
to type.

**5. Play a track.** It appears in the studio within a second, and on your overlay with it.

### Another browser, or another computer

The player and TokElements do not have to be in the same browser. On the TokElements SoundCloud page,
copy the pairing code. Then on the machine running SoundCloud, open the Tampermonkey menu while
`soundcloud.com` is in front and use **TokElements: set URL**, followed by
**TokElements: set pairing code**.

## The panel in the corner

The SoundCloud tab shows a small status panel at the bottom right: whether it is paired, whether
TokElements is reachable, whether you are signed in to SoundCloud, what is playing, and the result of
the last song request or skip. Red means something needs you, amber means it is waiting, orange means
it is sending.

## What is sent, and what is kept

Only what a now playing widget needs: title, artist, the address of the artwork, position, length,
play state, the tracks queued behind the current one, and whether anybody is signed in to the player.

None of it is written to a database. It is held in memory and expires by itself — the current track
after 45 seconds, the marker saying your browser is still connected after two minutes, and the
pairing code after 60 days or the moment you disconnect.

Your SoundCloud login never reaches TokElements. We hold no SoundCloud tokens, and our servers never
call SoundCloud: every request is made by your own browser, as you. The detail is in the
[TokElements privacy policy](https://tokelements.com/legal/privacy).

## When something stops working

**The overlay shows nothing.** Check that `soundcloud.com` is open in the same browser, that
Tampermonkey is enabled for it, and that the studio page says connected. The script needs that tab to
stay open; it does not run in the background on its own.

**Tracks show but requests do nothing.** The status panel says *player not reachable* when the script
is on its fallback. Reload the SoundCloud tab first; if it persists, update the script.

**Requests say no match.** Thirty-second previews of subscriber-only tracks are skipped on purpose,
so a request never puts a stub on your stream. Somebody asking for a track that only exists that way
gets the no-match answer, and their points back.

**It worked yesterday and stopped today.** SoundCloud changes its web player without notice, and this
script reads that player. Update to the newest version first, then
[open an issue](https://github.com/tokelements/tokelements-soundcloud/issues) with your browser, the
version from the top of the script, and what you saw.

## Updating

Tampermonkey checks for a new version on its own and installs it. To update now instead of waiting,
the Tampermonkey menu on the SoundCloud tab has **TokElements: check for updates**, and the
TokElements SoundCloud page names the version running in your browser and offers the newer one when
there is one.

## Uninstall

Open the Tampermonkey dashboard, find **TokElements for SoundCloud**, and delete it. Nothing stays
behind in your browser, and the pairing on the TokElements side expires by itself.

---

## About TokElements

[TokElements](https://tokelements.com) turns a TikTok LIVE broadcast into overlays for OBS. Gifts,
likes, follows and chat arrive as live events and drive whatever widgets you put on screen: alerts,
goals, leaderboards, games, counters. You can write widgets yourself in HTML, CSS and JavaScript, or
describe one in a sentence and have the assistant build it.

- **Website** — [tokelements.com](https://tokelements.com)
- **Widget documentation** — [tokelements.com/docs](https://tokelements.com/docs)
- **Widget kits other creators published** — [tokelements.com/kits](https://tokelements.com/kits)
- **Spotify instead of SoundCloud** — [tokelements-spotify](https://github.com/tokelements/tokelements-spotify)

Not affiliated with SoundCloud. SoundCloud is a trademark of SoundCloud Global Limited & Co. KG.

MIT licensed. See [LICENSE](LICENSE).
