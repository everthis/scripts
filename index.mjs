import puppeteer from "puppeteer";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";
import path from "node:path";
import * as readline from "node:readline/promises";

const { log } = console;

let targets = process.argv[2];

if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
}

async function processLineByLine() {
  const fileStream = fs.createReadStream("input.txt");
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  const res = [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  for await (const line of rl) {
    console.log(`Line from file: ${line}`);
    const foundUrls = line.match(urlRegex);

    if (foundUrls) {
      foundUrls.forEach((url) => res.push(url));
    }
  }

  console.log(res);
  return res;
}

function download(url, filename = "video.mp4") {
  return new Promise((resolve, reject) => {
    https
      .get(url, function (response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const fileStream = fs.createWriteStream(filename);
          response.pipe(fileStream);
        } else if (response.headers.location) {
          resolve(download(response.headers.location, filename));
        } else {
          reject(new Error(response.statusCode + " " + response.statusMessage));
        }
      })
      .on("error", function (err) {
        console.log(err);
        reject(err);
      })
      .on("close", function () {
        resolve();
      });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePath(str) {
  const { pathname } = new URL(str);
  let res = pathname.split("/").filter((x) => x);
  return res[res.length - 1];
}

async function retry(fn, retries = 3, delayMs = 0, ...args) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempt ${i + 1} of ${retries}`);
      const result = await fn(...args);
      return result;
    } catch (error) {
      lastError = error;
      if (i < retries - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function imgPath(obj) {
  return path.join(
    process.cwd(),
    "downloads",
    obj.awemeId +
      `__${obj.uid}` +
      `__${obj.sec_uid}` +
      `__${encodeURIComponent(obj.uri)}` +
      `__${obj.width}:${obj.height}` +
      "." +
      obj.type
  );
}

async function doDownload(assetUrl, filePath) {
  console.log("Downloading to", filePath);
  if (fs.existsSync(filePath)) {
    console.log("File exists, skipping", filePath);
    return;
  }
  await retry(download, 3, 0, assetUrl, filePath);
  console.log("Download completed:", filePath);
}
function genVideoPath(urlObj) {
  return path.join(
    process.cwd(),
    "downloads",
    urlObj.targetPath +
      `__${urlObj.uid}` +
      `__${urlObj.sec_uid}` +
      `__${urlObj.bitRate.FPS}FPS` +
      `__${urlObj.bitRate["play_addr"].width}x${urlObj.bitRate["play_addr"].height}` +
      `__${urlObj.bitRate["bit_rate"]}bps` +
      "." +
      urlObj.kind
  );
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  let page = await browser.newPage();
  if (!targets) {
    targets = await processLineByLine();
  } else {
    targets = targets.split(",").map((x) => x.trim());
  }

  for (const t of targets) {
    console.log("Processing:", t);
    try {
      await retry(single, 3, 1000, t);
    } catch (e) {
      console.error("Error processing", t, e);
    }
  }

  async function single(str) {
    let errNum = 0;
    if (page) {
      try {
        await page.close();
        page = await browser.newPage();
      } catch (error) {
        console.error("Error closing page:", error);
      }
    }
    const target = str.trim();
    await page.goto(target);
    console.log("Page loaded");
    // video
    const videoPromise = page
      .waitForResponse(
        (response) =>
          response
            .url()
            .startsWith("https://www.douyin.com/aweme/v1/web/aweme/detail/") &&
          response.status() === 200,
        { timeout: 5000 }
      )
      .then(resFn, errNumFn)
      .then((r) => r.json())
      .then(videoFn);

    const notePromise = page
      .waitForSelector(".note-detail-container button + div > img", {
        timeout: 5000,
      })
      .then(resFn, errNumFn)
      .then((r) => (r == null ? null : noteEval()))
      .then(noteFn);

    return Promise.race([videoPromise, notePromise]).then(() => {
      log("Processing completed for", target);
      log('\n')
    });

    function resFn(resp) {
      return resp;
    }
    function errNumFn(err) {
      errNum++;
      if (errNum >= 2) {
        throw new Error("Both video and note processing failed");
      }
    }
    function noteEval() {
      return page.evaluate(
        () => {
          const els = document.querySelectorAll(
            ".note-detail-container button + div > img"
          );
          const res = [];
          for (const e of els) {
            if (e.src) {
              res.push(e.src);
            }
          }
          if (res.length === 0) return res;
          let t;
          let src = res[0];
          let { pathname } = new URL(src);
          if (res.length) {
            let arr = document.querySelectorAll("script:not([src])");

            for (const e of arr) {
              if (e.innerHTML.indexOf(pathname) !== -1) {
                t = e;
                break;
              }
            }
          }
          const str = t.innerHTML;
          const tmpArr = str.split(".");
          const paceF = self[tmpArr[1]];
          let ans;

          for (let i = 0; i < paceF.length; i++) {
            const x = paceF[i];

            if (x[1] && typeof x[1] === "string" && x[1].includes(pathname)) {
              ans = x[1];
              break;
            }
          }
          if (ans) {
            const index = ans.indexOf(":");
            ans = ans.slice(index + 1);
            if (ans) {
              ans = JSON.parse(ans);
              ans = ans.at(-1);
            }
          }

          return ans;
        },
        { timeout: 5000 }
      );
    }

    async function noteFn(resp) {
      const { aweme, awemeId } = resp;
      const { detail: item } = aweme;

      if (item && item.images && item.images.length > 0) {
        console.log("images found, downloading images");
        for (let i = 0; i < item.images.length; i++) {
          const img = item.images[i];
          const imgUrl = img.urlList[1];
          const urlIns = new URL(imgUrl);
          const { pathname } = urlIns;
          const tmp = pathname.split(".");
          const ext = tmp[tmp.length - 1];
          const obj = {
            awemeId,
            uid: item.authorInfo.uid,
            sec_uid: item.authorInfo.secUid,
            uri: img.uri,
            width: img.width,
            height: img.height,
            type: ext,
          };
          const filePath = imgPath(obj);
          if (fs.existsSync(filePath)) {
            console.log("File exists, skipping", filePath);
          } else {
            await doDownload(imgUrl, filePath);
            console.log("Download completed:", filePath);
          }
        }
      }
    }

    async function videoFn(resp) {
      let r0 = resp["aweme_detail"]["video"]["bit_rate"],
        r1 = r0
          .slice(0)
          .sort((a, b) => b["play_addr"]["width"] - a["play_addr"]["width"]),
        r2 = r0.slice(0).sort((a, b) => b["bit_rate"] - a["bit_rate"]);

      const res = [
        {
          kind: r1[0]["format"],
          url: r1[0]["play_addr"]["url_list"][2],
          bitRate: r1[0],
        },
        {
          kind: r2[0]["format"],
          url: r2[0]["play_addr"]["url_list"][2],
          bitRate: r2[0],
        },
      ];
      res.forEach((x) => {
        x.targetPath = parsePath(target);
        x.uid = resp["aweme_detail"]["author"]["uid"];
        x.unique_id = resp["aweme_detail"]["author"]["unique_id"];
        x.sec_uid = resp["aweme_detail"]["author"]["sec_uid"];
      });

      const isSame = res[0].url === res[1].url;
      if (isSame) {
        log("Best quality and highest bitrate are the same.");
      } else {
        log("Best quality and highest bitrate are different.");
      }
      await doDownload(res[0].url, genVideoPath(res[0]));
      if (!isSame) {
        await doDownload(res[1].url, genVideoPath(res[1]));
      }
    }
  }

  await browser.close();
})();
