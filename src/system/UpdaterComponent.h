#ifndef UPDATERCOMPONENT_H
#define UPDATERCOMPONENT_H

#include <QCryptographicHash>
#include <QFile>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QVariantMap>

#include "ComponentManager.h"

class QNetworkReply;

///////////////////////////////////////////////////////////////////////////////////////////////////
// Arc's self-hosted updater, exposed to the web layer as api.updater.
//
// It reads a JSON feed whose URL is baked in at build time (CMake ARC_UPDATE_FEED_URL)
// or overridden by the hidden main.updateFeedUrl setting. dev/windows/publish-update.ps1
// writes the feed next to the installer it builds:
//
//   {
//     "version": "0.2.0",
//     "released": "2026-10-23",
//     "notes": "What changed",
//     "platforms": {
//       "windows-x64": {
//         "url": "https://.../Arc-0.2.0-x64.exe", "sha256": "<64 hex>", "size": 123,
//         "patches": [
//           { "from": "0.1.9", "url": "https://.../Arc-0.2.0-patch-from-0.1.9-x64.exe",
//             "sha256": "<64 hex>", "size": 45 }
//         ]
//       }
//     }
//   }
//
// Patches: an installer holding only the files that changed since one earlier version.
// Arc uses the patch whose "from" is its own version, and the full installer otherwise.
// If the patch download fails or does not verify, it switches to the full installer
// right away. A patch that was launched but did not leave Arc on the new version (its
// installer refuses to run on anything but the "from" version) is remembered, and the
// next attempt for that version uses the full installer.
//
// Automatic updates (main.autoUpdate, on by default): a few seconds after launch the
// feed is checked; a newer version is downloaded in the background and its SHA-256
// verified. If nothing is playing, the installer then runs silently and Arc restarts.
// If media is playing or paused, installation waits until playback ends. If Arc is
// closed first, the verified installer runs on exit and does not reopen Arc.
//
// With automatic updates off, updateAvailable lets the page ask the user, and
// install() downloads, verifies and installs right away.
//
// Feed and installer must be served over HTTPS, except from loopback hosts for local
// testing. Platforms without a silent installer get their download URL opened instead.
class UpdaterComponent : public ComponentBase
{
  Q_OBJECT
  DEFINE_SINGLETON(UpdaterComponent);

public:
  const char* componentName() override { return "updater"; }
  bool componentExport() override { return true; }
  bool componentInitialize() override { return true; }
  void componentPostInitialize() override;

  // Fetch the feed and emit updateAvailable, upToDate or updateError. The first
  // result is reused for the rest of the session unless force is true.
  Q_INVOKABLE void check(bool force = false);

  // Download (if not already downloaded), verify and install the update announced by
  // the last updateAvailable now, even during playback: the user asked for it.
  Q_INVOKABLE void install();

  Q_INVOKABLE QString currentVersion() const;
  Q_INVOKABLE QString feedUrl() const;
  Q_INVOKABLE bool autoUpdateEnabled() const;

  // Where the updater is: phase is one of idle, checking, upToDate, available,
  // downloading, waiting (verified, held until playback stops), installing, error.
  // Also carries version, received, total and message.
  Q_INVOKABLE QVariantMap status() const;

  Q_SIGNAL void updateAvailable(const QVariantMap& update);
  Q_SIGNAL void upToDate(const QString& version);
  Q_SIGNAL void updateError(const QString& message);
  Q_SIGNAL void downloadProgress(qint64 received, qint64 total);
  Q_SIGNAL void waitingForPlayback(const QString& version);
  Q_SIGNAL void installing(const QString& version);

private:
  explicit UpdaterComponent(QObject* parent = nullptr);

  static QString platformKey();
  static bool isAllowedUrl(const QUrl& url);

  void startDownload(bool automatic);
  void onFeedFinished(QNetworkReply* reply);
  void onDownloadFinished();
  void failInstall(const QString& message);
  bool retryWithFullInstaller(const QString& reason);

  // Patch bookkeeping: the version a patch installer was last launched for.
  static QString patchAttemptFile();
  static QString lastPatchAttempt();
  static void setLastPatchAttempt(const QString& version);
  void installWhenIdle();
  void launchInstaller(bool relaunchAndQuit);
  void onAboutToQuit();
  void emitResult();

  QNetworkAccessManager* m_network;
  QPointer<QNetworkReply> m_feedReply;
  QPointer<QNetworkReply> m_downloadReply;

  enum class Result { None, Available, UpToDate, Error };
  Result m_result = Result::None;
  QString m_resultMessage;
  QVariantMap m_update;

  QString m_phase = "idle";
  qint64 m_received = 0;
  qint64 m_total = 0;

  bool m_automatic = false;        // the running download was started automatically
  bool m_mediaActive = false;      // something is playing, paused or buffering
  bool m_installerLaunched = false;
  QString m_readyInstaller;        // verified installer waiting to run

  QFile m_download;
  QCryptographicHash m_hash;
};

#endif // UPDATERCOMPONENT_H
