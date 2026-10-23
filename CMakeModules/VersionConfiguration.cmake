# Get the current date.
string(TIMESTAMP CURRENT_DATE "%Y-%m-%d")

option(UPGRADE_DEBUG "" OFF)

# Where Arc's in-app updater looks for new versions: the arc-update.json that
# dev/windows/publish-update.ps1 writes, attached to each GitHub release. The
# "latest/download" URL always resolves to the newest published release. Set it
# empty to build without update checks; the hidden main.updateFeedUrl setting
# overrides it at runtime for testing.
set(ARC_UPDATE_FEED_URL "https://github.com/Fareszaghloul/arc-player/releases/latest/download/arc-update.json"
    CACHE STRING "URL of the arc-update.json update feed")

# Read version from VERSION file
# Re-run configure whenever VERSION changes; otherwise an existing build keeps the
# old version, and a release whose feed says X.Y.Z would ship an app reporting an
# older version, so installed copies would update to it over and over.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/VERSION")
file(READ "${CMAKE_SOURCE_DIR}/VERSION" VERSION_STRING)
string(STRIP "${VERSION_STRING}" VERSION_STRING)

# Extract major.minor.patch for places that need it
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" VERSION_BASE "${VERSION_STRING}")
if(NOT VERSION_BASE)
  set(VERSION_BASE "0.0.0")
endif()

set(VERSION_STRING_SHORT "${VERSION_BASE}")
set(CANONICAL_VERSION_STRING "${VERSION_BASE}")

configure_file(src/core/Version.cpp.in src/core/Version.cpp)
