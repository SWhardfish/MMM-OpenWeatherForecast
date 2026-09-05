/*********************************

  Node Helper for MMM-OpenWeatherForecast.

  Optimized version with async graph generation and debouncing
  FIXED: Ensures non-blocking graph generation with proper file handling

*********************************/

var NodeHelper = require("node_helper");
var axios = require("axios").default;
var moment = require("moment");
var fs = require("fs");
var path = require("path");
const { spawn } = require("child_process");

const DATA_FILE = path.resolve(__dirname, "weather_data.json");
const GRAPH_SCRIPT = path.resolve(__dirname, "Graphplot/GraphPlot.py");

module.exports = NodeHelper.create({
  start: function () {
    console.log("====================== Starting node_helper for module [" + this.name + "]");

    // Ensure the data file exists
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify([]));
    }

    // Track graph generation state
    this.graphGenerating = false;
    this.graphUpdatePending = false;
    this.lastGraphUpdate = 0;
    this.GRAPH_UPDATE_INTERVAL = 15 * 60 * 1000; // Minimum 15 minutes between graph updates
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "OPENWEATHER_FORECAST_GET") {
      if (payload.apikey == null || payload.apikey === "") {
        console.log(
          "[MMM-OpenWeatherForecast] " +
            moment().format("D-MMM-YY HH:mm") +
            " ** ERROR ** No API key configured."
        );
      } else if (
        payload.latitude == null ||
        payload.latitude === "" ||
        payload.longitude == null ||
        payload.longitude === ""
      ) {
        console.log(
          "[MMM-OpenWeatherForecast] " +
            moment().format("D-MMM-YY HH:mm") +
            " ** ERROR ** Latitude and/or longitude not provided."
        );
      } else {
        var url =
          "https://api.openweathermap.org/data/3.0/onecall?" +
          "lat=" +
          payload.latitude +
          "&lon=" +
          payload.longitude +
          "&exclude=minutely" +
          "&appid=" +
          payload.apikey +
          "&units=" +
          payload.units +
          "&lang=" +
          payload.language;

        axios
          .get(url)
          .then((response) => {
            response.data.instanceId = payload.instanceId;

            // Save data to local JSON file
            this.saveData(response.data);

            // Send data to the frontend IMMEDIATELY (don't wait for graph)
            this.sendSocketNotification("OPENWEATHER_FORECAST_DATA", response.data);

            // Schedule graph update asynchronously with debouncing (only when enabled)
            if (payload.showGraphPlot === false) {
              console.log("[MMM-OpenWeatherForecast] Graph plotting disabled for this instance");
            } else {
              this.scheduleGraphUpdate();
            }
          })
          .catch(function (error) {
            console.log(
              "[MMM-OpenWeatherForecast] " +
                moment().format("D-MMM-YY HH:mm") +
                " ** ERROR ** " +
                error
            );
          });
      }
    }
  },

  scheduleGraphUpdate: function () {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastGraphUpdate;

    // If already generating, mark that we need another update after
    if (this.graphGenerating) {
      this.graphUpdatePending = true;
      console.log("[MMM-OpenWeatherForecast] Graph update pending (already generating)");
      return;
    }

    // If updated recently, schedule for later
    if (timeSinceLastUpdate < this.GRAPH_UPDATE_INTERVAL) {
      if (!this.graphUpdatePending) {
        const delay = this.GRAPH_UPDATE_INTERVAL - timeSinceLastUpdate;
        console.log(`[MMM-OpenWeatherForecast] Scheduling graph update in ${Math.round(delay/1000)}s`);

        this.graphUpdatePending = true;
        setTimeout(() => {
          this.graphUpdatePending = false;
          this.generateGraph();
        }, delay);
      }
      return;
    }

    // Otherwise, update now
    this.generateGraph();
  },

  generateGraph: function () {
    if (this.graphGenerating) {
      console.log("[MMM-OpenWeatherForecast] Graph generation already in progress, skipping");
      return;
    }

    this.graphGenerating = true;
    this.lastGraphUpdate = Date.now();
    console.log("[MMM-OpenWeatherForecast] Starting graph generation...");

    const self = this;

    // Try candidates in order. On Raspberry Pi prefer python3, but try 'python' as fallback.
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    let tried = 0;

    let pythonProcess = null;
    let stdout = "";
    let stderr = "";

    const trySpawn = function() {
      if (tried >= candidates.length) {
        self.graphGenerating = false;
        console.error('[MMM-OpenWeatherForecast] Unable to start Python: no candidate commands worked');
        return;
      }

      const cmd = candidates[tried++];
      console.log(`[MMM-OpenWeatherForecast] Attempting to run graph script with: ${cmd}`);

      try {
        pythonProcess = spawn(cmd, [GRAPH_SCRIPT]);
      } catch (err) {
        console.error(`[MMM-OpenWeatherForecast] spawn failed for ${cmd}: ${err.message}`);
        // try next candidate
        setImmediate(trySpawn);
        return;
      }

      pythonProcess.stdout.on("data", (data) => {
        const s = data.toString();
        stdout += s;
        // Stream output immediately to logs for visibility
        console.log("[MMM-OpenWeatherForecast][GraphPlot stdout] " + s.trim());
      });

      pythonProcess.stderr.on("data", (data) => {
        const s = data.toString();
        stderr += s;
        // Stream stderr immediately to logs
        console.error("[MMM-OpenWeatherForecast][GraphPlot stderr] " + s.trim());
      });

      pythonProcess.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle); // Clear the timeout when process completes
        self.graphGenerating = false;

        if (code !== 0) {
          console.error(`[MMM-OpenWeatherForecast] GraphPlot exited with code ${code}`);
          if (stderr) {
            console.error("[MMM-OpenWeatherForecast] GraphPlot stderr:", stderr.trim());
          }
          // Try next candidate if any
          setImmediate(trySpawn);
        } else {
          console.log("[MMM-OpenWeatherForecast] Graph updated successfully");
          if (stdout) {
            console.log("[MMM-OpenWeatherForecast] GraphPlot output:", stdout.trim());
          }

          // Delay to ensure file is fully written and synced to disk (especially on Raspberry Pi)
          setTimeout(() => {
            console.log("[MMM-OpenWeatherForecast] Notifying frontend that graph is ready");
            self.sendSocketNotification("OPENWEATHER_FORECAST_GRAPH_READY");
          }, 1000);

          // If another update was requested while we were generating, schedule it properly
          if (self.graphUpdatePending) {
            console.log("[MMM-OpenWeatherForecast] Pending graph update will be processed according to schedule");
            // Don't immediately regenerate - let the normal scheduling handle it
            // This prevents rapid-fire graph generation
          }
        }
      });

      pythonProcess.on('error', (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle); // Clear timeout on error
        // spawn() may emit 'error' if the command isn't found - try the next candidate
        console.error(`[MMM-OpenWeatherForecast] Failed to start GraphPlot with ${cmd}: ${error.message}`);
        // ensure we clear any partial state then try next
        try {
          if (pythonProcess && pythonProcess.kill) pythonProcess.kill();
        } catch (e) {}
        setImmediate(trySpawn);
      });

      // Safety timeout: if the process takes too long, kill it
      const TIMEOUT_MS = 120000; // 2 minutes
      timeoutHandle = setTimeout(() => {
        if (pythonProcess && !pythonProcess.killed) {
          console.error('[MMM-OpenWeatherForecast] GraphPlot timed out - killing process');
          try { pythonProcess.kill(); } catch (e) {}
          self.graphGenerating = false;
          // Don't automatically retry - let the normal update cycle handle it
          // This prevents endless timeout->retry loops
          console.log('[MMM-OpenWeatherForecast] Next graph update will occur on normal schedule');
        }
      }, TIMEOUT_MS);

    };

    // Start first attempt
    trySpawn();
  },

  saveData: function (data) {
    try {
      const filteredData = {
        lat: data.lat,
        lon: data.lon,
        timezone: data.timezone,
        timezone_offset: data.timezone_offset,
        data: data.current
          ? [
              {
                dt: data.current.dt,
                temp: data.current.temp,
                humidity: data.current.humidity,
                weather: data.current.weather,
                // Capture precipitation data (default to 0 if not present)
                rain: (data.current.rain && data.current.rain["1h"]) ? data.current.rain["1h"] : 0,
                snow: (data.current.snow && data.current.snow["1h"]) ? data.current.snow["1h"] : 0
              },
            ]
          : [],
      };

      let existingData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      filteredData.timestamp = moment().valueOf();
      existingData.push(filteredData);

      // Trim data older than 72 hours
      const cutoff = moment().subtract(72, "hours").valueOf();
      existingData = existingData.filter((entry) => entry.timestamp >= cutoff);

      // FIXED: Ensure data is written synchronously and flushed to disk
      fs.writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));

      // Force sync to disk to ensure data is persisted
      const fd = fs.openSync(DATA_FILE, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      console.log("[MMM-OpenWeatherForecast] Weather data saved and synced to JSON file on disk");
    } catch (error) {
      console.log(
        "[MMM-OpenWeatherForecast] ** ERROR ** Could not save data: " + error
      );
    }
  },
});