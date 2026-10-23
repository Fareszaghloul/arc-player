#include "UpdaterComponent.h"

#include <QCoreApplication>
#include <QDebug>
#include <QDesktopServices>
#include <QDir>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QProcess>
#include <QRegularExpression>
#include <QStandardPaths>
#include <QSysInfo>
#include <QTimer>
#include <QVersionNumber>

#include "Version.h"
#include "player/PlayerComponent.h"
#include "settings/SettingsComponent.h"
#include "system/SystemComponent.h"

static const int FEED_TIMEOUT_MS = 15000;
static const int DOWNLOAD_STALL_TIMEOUT_MS = 60000;
static const int STARTUP_CHECK_DELAY_MS = 4000;

///////////////////////////////////////////////////////////////////////////////////////////////////
UpdaterComponent::UpdaterComponent(QObject* parent)
  : ComponentBase(parent),
    m_network(new QNetworkAccessManager(this)),
    m_hash(QCryptographicHash::Sha256)
{
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::componentPostInitialize()
{
  // Track whether media is loaded so an automatic update never restarts Arc mid-film.
  connect(&PlayerComponent::Get(), &PlayerComponent::stateChanged, this,
          [this](PlayerComponent::State state, PlayerComponent::State)
  {
    m_mediaActive = state == PlayerComponent::State::playing ||
                    state == PlayerComponent::State::paused ||
                    state == PlayerComponent::State::buffering;
    if (!m_mediaActive && m_phase == "waiting")
    {
      qInfo() << "Updater: playback ended, installing the downloaded update";
      launchInstaller(true);
    }
  });

  connect(qApp, &QCoreApplication::aboutToQuit, this, &UpdaterComponent::onAboutToQuit);

#ifndef DISABLE_UPDATE_CHECK
  // Check on every launch, independent of which page is showing.
  if (SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "checkForUpdates").toBool())
    QTimer::singleShot(STARTUP_CHECK_DELAY_MS, this, [this]() { check(false); });
#endif
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString UpdaterComponent::currentVersion() const
{
  return Version::GetCanonicalVersionString();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString UpdaterComponent::feedUrl() const
{
  QString overrideUrl = SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "updateFeedUrl").toString().trimmed();
  if (!overrideUrl.isEmpty())
    return overrideUrl;
  return Version::GetUpdateFeedUrl();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool UpdaterComponent::autoUpdateEnabled() const
{
  return SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "autoUpdate").toBool();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap UpdaterComponent::status() const
{
  QVariantMap s;
  s.insert("phase", m_phase);
  s.insert("version", m_update.value("version"));
  s.insert("currentVersion", currentVersion());
  s.insert("received", m_received);
  s.insert("total", m_total);
  s.insert("message", m_resultMessage);
  s.insert("automatic", m_automatic);
  return s;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString UpdaterComponent::platformKey()
{
#if defined(Q_OS_WIN)
  QString os = "windows";
#elif defined(Q_OS_MAC)
  QString os = "macos";
#else
  QString os = "linux";
#endif
  // The architecture this binary was built for, which is what an installer must match.
  QString arch = QSysInfo::buildCpuArchitecture();
  if (arch == "x86_64")
    arch = "x64";
  return os + "-" + arch;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool UpdaterComponent::isAllowedUrl(const QUrl& url)
{
  if (!url.isValid())
    return false;
  if (url.scheme() == "https")
    return true;
  if (url.scheme() != "http")
    return false;

  // Plain HTTP only for a feed on this machine, which is how updates are tested.
  QString host = url.host();
  if (host == "localhost")
    return true;
  QHostAddress address(host);
  return !address.isNull() && address.isLoopback();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::emitResult()
{
  switch (m_result)
  {
    case Result::Available:
      emit updateAvailable(m_update);
      break;
    case Result::UpToDate:
      emit upToDate(currentVersion());
      break;
    case Result::Error:
      emit updateError(m_resultMessage);
      break;
    case Result::None:
      break;
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::check(bool force)
{
#ifdef DISABLE_UPDATE_CHECK
  emit updateError("Update checks are disabled in this build");
  return;
#endif

  if (m_feedReply)
    return; // a check is already running and will emit its result

  if (m_result != Result::None && !force)
  {
    emitResult();
    return;
  }

  QUrl url(feedUrl());
  if (url.isEmpty())
  {
    qInfo() << "Updater: no update feed configured";
    m_result = Result::Error;
    m_phase = "error";
    m_resultMessage = "No update feed is configured for this build";
    emitResult();
    return;
  }
  if (!isAllowedUrl(url))
  {
    qWarning() << "Updater: refusing feed URL" << url.toString() << "(HTTPS required)";
    m_result = Result::Error;
    m_phase = "error";
    m_resultMessage = "The update feed must use HTTPS";
    emitResult();
    return;
  }

  qInfo() << "Updater: checking" << url.toString() << "for" << platformKey() << "current" << currentVersion();
  if (m_phase == "idle" || m_phase == "upToDate" || m_phase == "error")
    m_phase = "checking";

  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, SystemComponent::Get().getUserAgent());
  request.setRawHeader("Cache-Control", "no-cache");
  request.setTransferTimeout(FEED_TIMEOUT_MS);

  m_feedReply = m_network->get(request);
  QNetworkReply* reply = m_feedReply;
  connect(reply, &QNetworkReply::finished, this, [this, reply]() { onFeedFinished(reply); });
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::onFeedFinished(QNetworkReply* reply)
{
  reply->deleteLater();

  auto fail = [this](const QString& message)
  {
    qWarning() << "Updater:" << message;
    m_result = Result::Error;
    m_phase = "error";
    m_resultMessage = message;
    emitResult();
  };

  if (reply->error() != QNetworkReply::NoError)
  {
    fail(QString("Could not reach the update feed: %1").arg(reply->errorString()));
    return;
  }

  QByteArray body = reply->readAll();
  if (body.startsWith("\xEF\xBB\xBF"))
    body.remove(0, 3);

  QJsonParseError parseError;
  QJsonDocument doc = QJsonDocument::fromJson(body, &parseError);
  if (!doc.isObject())
  {
    fail(QString("The update feed is not valid JSON: %1").arg(parseError.errorString()));
    return;
  }

  QJsonObject feed = doc.object();
  QString version = feed.value("version").toString().trimmed();
  QVersionNumber remote = QVersionNumber::fromString(version);
  QVersionNumber local = QVersionNumber::fromString(currentVersion());
  if (remote.isNull())
  {
    fail(QString("The update feed has no usable version (\"%1\")").arg(version));
    return;
  }

  if (QVersionNumber::compare(remote, local) <= 0)
  {
    qInfo() << "Updater: up to date (feed" << version << "current" << currentVersion() << ")";
    m_result = Result::UpToDate;
    m_phase = "upToDate";
    emitResult();
    return;
  }

  QString key = platformKey();
  QJsonObject entry = feed.value("platforms").toObject().value(key).toObject();
  QUrl downloadUrl(entry.value("url").toString());
  QString sha256 = entry.value("sha256").toString().trimmed().toLower();

  if (entry.isEmpty())
  {
    qInfo() << "Updater: version" << version << "has no build for" << key;
    m_result = Result::UpToDate;
    m_phase = "upToDate";
    emitResult();
    return;
  }
  if (!isAllowedUrl(downloadUrl))
  {
    fail(QString("The download for %1 must use HTTPS").arg(version));
    return;
  }
  static const QRegularExpression sha256Pattern("^[0-9a-f]{64}$");
  if (!sha256Pattern.match(sha256).hasMatch())
  {
    fail(QString("The update feed has no valid SHA-256 for %1 %2").arg(key, version));
    return;
  }

  // A forced re-check that finds the same version keeps the download in progress.
  bool sameUpdate = m_result == Result::Available && m_update.value("version").toString() == version;

  m_update.clear();
  m_update.insert("version", version);
  m_update.insert("currentVersion", currentVersion());
  m_update.insert("notes", feed.value("notes").toString());
  m_update.insert("released", feed.value("released").toString());
  m_update.insert("platform", key);
  m_update.insert("url", downloadUrl.toString());
  m_update.insert("sha256", sha256);
  m_update.insert("size", entry.value("size").toVariant());
#ifdef Q_OS_WIN
  m_update.insert("canInstall", true);
#else
  m_update.insert("canInstall", false);
#endif
  m_update.insert("automatic", autoUpdateEnabled());

  qInfo() << "Updater: version" << version << "available for" << key << "from" << downloadUrl.toString();
  m_result = Result::Available;
  if (!sameUpdate)
    m_phase = "available";
  emitResult();

  if (!sameUpdate && autoUpdateEnabled() && m_update.value("canInstall").toBool())
  {
    qInfo() << "Updater: downloading" << version << "automatically";
    startDownload(true);
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::failInstall(const QString& message)
{
  qWarning() << "Updater:" << message;
  if (m_download.isOpen())
    m_download.close();
  if (!m_download.fileName().isEmpty())
    m_download.remove();
  m_phase = "error";
  m_resultMessage = message;
  emit updateError(message);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::install()
{
  startDownload(false);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::startDownload(bool automatic)
{
  if (m_result != Result::Available)
  {
    emit updateError("There is no update to install");
    return;
  }

  if (m_installerLaunched)
    return;

  // Already verified and waiting for playback to stop: the user wants it now.
  if (!m_readyInstaller.isEmpty())
  {
    if (!automatic)
      launchInstaller(true);
    return;
  }

  if (m_downloadReply)
  {
    // A manual request during an automatic download installs as soon as it finishes.
    if (!automatic)
      m_automatic = false;
    return;
  }

  QUrl url(m_update.value("url").toString());

#ifndef Q_OS_WIN
  // No silent installer on this platform yet: hand the download to the browser.
  if (!automatic)
  {
    qInfo() << "Updater: opening download" << url.toString();
    QDesktopServices::openUrl(url);
  }
  return;
#endif

  QString dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation) + "/arc-update";
  if (!QDir().mkpath(dir))
  {
    failInstall("Could not create a folder for the download");
    return;
  }

  QString fileName = url.fileName();
  static const QRegularExpression safeName("^[A-Za-z0-9._-]+\\.exe$");
  if (!safeName.match(fileName).hasMatch())
    fileName = QString("Arc-%1-setup.exe").arg(m_update.value("version").toString());

  if (m_download.isOpen())
    m_download.close();
  m_download.setFileName(dir + "/" + fileName);
  m_download.remove();
  if (!m_download.open(QIODevice::WriteOnly))
  {
    failInstall(QString("Could not write %1: %2").arg(m_download.fileName(), m_download.errorString()));
    return;
  }
  m_hash.reset();
  m_automatic = automatic;
  m_received = 0;
  m_total = m_update.value("size").toLongLong();
  m_phase = "downloading";

  qInfo() << "Updater: downloading" << url.toString() << "to" << m_download.fileName()
          << (automatic ? "(automatic)" : "(requested)");

  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, SystemComponent::Get().getUserAgent());
  request.setTransferTimeout(DOWNLOAD_STALL_TIMEOUT_MS);
  // Qt's HTTP/2 client keeps a 64 KiB receive window, which caps a download at about
  // 64 KiB per round trip (~1.5 MB/s to GitHub) regardless of the connection. HTTP/1.1
  // over one TCP stream uses the full bandwidth.
  request.setAttribute(QNetworkRequest::Http2AllowedAttribute, false);

  m_downloadReply = m_network->get(request);
  QNetworkReply* reply = m_downloadReply;

  connect(reply, &QNetworkReply::readyRead, this, [this, reply]()
  {
    QByteArray chunk = reply->readAll();
    m_hash.addData(chunk);
    if (m_download.write(chunk) != chunk.size())
    {
      reply->abort();
    }
  });
  connect(reply, &QNetworkReply::downloadProgress, this, [this](qint64 received, qint64 total)
  {
    m_received = received;
    if (total > 0)
      m_total = total;
    emit downloadProgress(received, total);
  });
  connect(reply, &QNetworkReply::finished, this, &UpdaterComponent::onDownloadFinished);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::onDownloadFinished()
{
  QNetworkReply* reply = m_downloadReply;
  if (!reply)
    return;
  reply->deleteLater();

  // Collect anything left after the last readyRead.
  QByteArray rest = reply->readAll();
  if (!rest.isEmpty())
  {
    m_hash.addData(rest);
    m_download.write(rest);
  }

  // A failed disk write aborts the reply, so report the file error first.
  if (m_download.error() != QFileDevice::NoError)
  {
    failInstall(QString("Could not save the download: %1").arg(m_download.errorString()));
    return;
  }
  if (reply->error() != QNetworkReply::NoError)
  {
    failInstall(QString("The download failed: %1").arg(reply->errorString()));
    return;
  }
  m_download.close();

  QString actual = QString::fromLatin1(m_hash.result().toHex());
  QString expected = m_update.value("sha256").toString();
  if (actual != expected)
  {
    failInstall(QString("The download did not match its published checksum, so it was discarded "
                        "(expected %1, got %2)").arg(expected, actual));
    return;
  }

  bool sizeOk = false;
  qint64 expectedSize = m_update.value("size").toLongLong(&sizeOk);
  if (sizeOk && expectedSize > 0 && m_download.size() != expectedSize)
  {
    failInstall(QString("The download is %1 bytes but the feed says %2").arg(m_download.size()).arg(expectedSize));
    return;
  }

  m_readyInstaller = QDir::toNativeSeparators(m_download.fileName());
  qInfo() << "Updater: checksum verified for" << m_readyInstaller;

  if (m_automatic)
    installWhenIdle();
  else
    launchInstaller(true);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::installWhenIdle()
{
  if (m_mediaActive)
  {
    QString version = m_update.value("version").toString();
    qInfo() << "Updater: holding" << version << "until playback stops";
    m_phase = "waiting";
    emit waitingForPlayback(version);
    return;
  }
  launchInstaller(true);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::launchInstaller(bool relaunchAndQuit)
{
  if (m_installerLaunched || m_readyInstaller.isEmpty())
    return;

  QString version = m_update.value("version").toString();
  QStringList args = { "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART" };
  if (!relaunchAndQuit)
    args << "/NoRelaunch=1"; // Arc is already closing; the user chose to quit, so stay closed

  qInfo() << "Updater: starting installer" << m_readyInstaller << args;
  if (!QProcess::startDetached(m_readyInstaller, args))
  {
    m_readyInstaller.clear();
    failInstall("The installer could not be started");
    return;
  }

  m_installerLaunched = true;
  m_phase = "installing";
  emit installing(version);

  if (relaunchAndQuit)
  {
    // Give the page a moment to show "installing", then quit so the installer can
    // replace our files. The installer also closes Arc itself if it is still running.
    QTimer::singleShot(1200, this, []() { SystemComponent::Get().exit(); });
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void UpdaterComponent::onAboutToQuit()
{
  // A verified update that was waiting for playback to end installs as Arc closes.
  if (!m_installerLaunched && !m_readyInstaller.isEmpty())
  {
    qInfo() << "Updater: Arc is closing, installing the downloaded update";
    launchInstaller(false);
  }
}
