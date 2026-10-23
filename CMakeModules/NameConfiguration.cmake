set(MAIN_TARGET Arc)

# Output binary name
set(MAIN_NAME arc-player)

# Data directory name - also used for QCoreApplication::applicationName
# which determines QStandardPaths (cache, config, data dirs)
set(DATA_NAME arc-player)

if(APPLE)
  set(MAIN_NAME "Arc")
  set(DATA_NAME "Arc")
elseif(WIN32)
  set(MAIN_NAME "Arc")
  set(DATA_NAME "Arc")
endif()

configure_file(src/shared/Names.cpp.in src/shared/Names.cpp @ONLY)
