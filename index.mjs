import puppeteer from "puppeteer";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";
import path from "node:path";
import * as readline from "node:readline/promises";

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
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError
}

function imgPath(obj) {
  return path.join(
        process.cwd(),
        "downloads",
        obj.awemeId +
          `__${obj.uid}` +
          `__${obj.sec_uid}` +
          `__${encodeURIComponent(obj.uri)}` +
          `__${obj.width}x${obj.height}` +
          "." +
          obj.type
      );
}

;(async () => {
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
    const videoPromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .startsWith("https://www.douyin.com/aweme/v1/web/aweme/detail/") &&
        response.status() === 200,
      { timeout: 5000 }
    );
    // images
    // https://www.douyin.com/aweme/v1/web/aweme/post/
    // aweme_list[0].images[i].url_list[1]
    const imgPromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .startsWith("https://www.douyin.com/aweme/v1/web/aweme/post/") &&
        response.status() === 200,
      { timeout: 5000 }
    );

    const resp = await Promise.race([videoPromise, imgPromise]).then(r => r.json());

    console.log("Final request captured");
    if(resp.aweme_list && resp.aweme_list.length > 0){
      const curUrl = await page.url();
      const awemeId = parsePath(curUrl);
      const item = resp.aweme_list.find(x => x.aweme_id === awemeId);
      if(item && item.images && item.images.length > 0){
        console.log('images found, downloading images');
        for(let i = 0; i < item.images.length; i++){
          const img = item.images[i];
          const imgUrl = img.url_list[1];
          const urlIns = new URL(imgUrl);
          const { pathname } = urlIns;
          const tmp = pathname.split('.')
          const ext = tmp[tmp.length - 1];
          const obj = {
            awemeId,
            uid: item.author.uid,
            sec_uid: item.author.sec_uid,
            uri: img.uri,
            width: img.width,
            height: img.height,
            type: ext
          }
          const filePath = imgPath(obj);
          if(fs.existsSync(filePath)){
            console.log('File exists, skipping', filePath);
          } else {
            console.log('Downloading image to', filePath);
            await download(imgUrl, filePath);
            console.log('Download completed:', filePath);
          }
        }
      }
      return;
    }

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
      x.uid = resp["aweme_detail"]["author"]["uid"];
      x.unique_id = resp["aweme_detail"]["author"]["unique_id"];
      x.sec_uid = resp["aweme_detail"]["author"]["sec_uid"];
    });

    console.log(res);
    const isSame = res[0].url === res[1].url;
    if (isSame) {
      console.log("Best quality and highest bitrate are the same.");
    } else {
      console.log("Best quality and highest bitrate are different.");
    }
    const genPath = (urlObj) =>
      path.join(
        process.cwd(),
        "downloads",
        parsePath(target) +
          `__${urlObj.uid}` +
          `__${urlObj.sec_uid}` +
          `__${urlObj.bitRate.FPS}FPS` +
          `__${urlObj.bitRate['play_addr'].width}x${urlObj.bitRate['play_addr'].height}` +
          `__${urlObj.bitRate['bit_rate']}bps` +
          "." +
          urlObj.kind
      );
    const doDownload = async (urlObj) => {
      const filePath = genPath(urlObj);
      console.log("Downloading to", filePath);
      await download(urlObj.url, filePath);
      console.log("Download completed:", filePath);
    };
    await doDownload(res[0]);

    if (!isSame) {
      await sleep(1000);
      await doDownload(res[1]);
    }
  }

  await browser.close();
})();
