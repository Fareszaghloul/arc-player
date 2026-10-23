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
//       "windows-x64": { "url": "https://.../Arc-0.2.0-x64.exe", "sha256": "<64 hex>", "size": 123 }
//     }
//   }
//
// When the feed's version is newer than this build, updateAvailable fires. install()
// then downloads the installer for this platform, refuses it unless its SHA-256
// matches the feed, runs it silently and quits so it can replace the app; the Inno
// Setup script relaunches Arc after a silent install. Feed and installer must be
// served over HTTPS, except from loopback hosts for local testing. Platforms without
// a silent installer get their download URL opened in the browser instead.
class UpdaterComponent : public ComponentBase
{
  Q_OBJECT
  DEFINE_SINGLETON(UpdaterComponent);

public:
  const char* componentName() override { return "updater"; }
  bool componentExport() override { return true; }
  bool componentInitialize() override { return true; }

  // Fetch the feed and emit updateAvailable, upToDate or updateError. The first
  // result is reused for the rest of the session unless force is true.
  Q_INVOKABLE void check(bool force = false);

  // Download, verify and run the installer announced by the last updateAvailable.
  Q_INVOKABLE void install();

  Q_INVOKABLE QString currentVersion() const;
  Q_INVOKABLE QString feedUrl() const;

  Q_SIGNAL void updateAvailable(const QVariantMap& update);
  Q_SIGNAL void upToDate(const QString& version);
  Q_SIGNAL void updateError(const QString& message);
  Q_SIGNAL void downloadProgress(qint64 received, qint64 total);
  Q_SIGNAL void installing(const QString& version);

private:
  explicit UpdaterComponent(QObject* parent = nullptr);

  static QString platformKey();
  static bool isAllowedUrl(const QUrl& url);

  void onFeedFinished(QNetworkReply* reply);
  void onDownloadFinished();
  void failInstall(const QString& message);
  void emitResult();

  QNetworkAccessManager* m_network;
  QPointer<QNetworkReply> m_feedReply;
  QPointer<QNetworkReply> m_downloadReply;

  enum class Result { None, Available, UpToDate, Error };
  Result m_result = Result::None;
  QString m_resultMessage;
  QVariantMap m_update;

  QFile m_download;
  QCryptographicHash m_hash;
};

#endif // UPDATERCOMPONENT_H
