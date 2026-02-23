const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('Opening Tavily sign-in page...');
  await page.goto('https://app.tavily.com/sign-in', { waitUntil: 'networkidle', timeout: 30000 });
  
  // Find captcha image and get its src
  const captchaInfo = await page.evaluate(() => {
    const img = document.querySelector('img[alt*="captcha"]');
    if (!img) return null;
    return {
      src: img.src,
      alt: img.alt,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    };
  });
  
  console.log('Captcha info:', JSON.stringify(captchaInfo, null, 2));
  
  // Take a high-res screenshot of just the captcha
  const captchaEl = await page.$('img[alt*="captcha"]');
  if (captchaEl) {
    await captchaEl.screenshot({ path: 'data/tavily-captcha-hires.png' });
    console.log('High-res captcha saved');
    
    // Get base64 of the captcha image
    const captchaBase64 = await page.evaluate(() => {
      const img = document.querySelector('img[alt*="captcha"]');
      if (!img) return null;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    });
    
    if (captchaBase64) {
      // Save as file for inspection
      const base64Data = captchaBase64.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync('data/tavily-captcha-canvas.png', Buffer.from(base64Data, 'base64'));
      console.log('Canvas captcha saved');
      console.log('Base64 length:', base64Data.length);
      // Print first 200 chars for debugging
      console.log('Base64 preview:', base64Data.substring(0, 200));
    }
  }
  
  // Also check if captcha is SVG-based
  const svgContent = await page.evaluate(() => {
    const captchaContainer = document.querySelector('img[alt*="captcha"]');
    if (!captchaContainer) return null;
    // Check parent for SVG
    const parent = captchaContainer.parentElement;
    const svg = parent ? parent.querySelector('svg') : null;
    return svg ? svg.outerHTML : null;
  });
  
  if (svgContent) {
    console.log('SVG captcha found:', svgContent.substring(0, 500));
  }
  
  // Get the captcha src - if it's a data URI, it might be readable
  if (captchaInfo && captchaInfo.src) {
    if (captchaInfo.src.startsWith('data:')) {
      console.log('Captcha is data URI, length:', captchaInfo.src.length);
      // If SVG, extract text
      if (captchaInfo.src.includes('svg')) {
        const decoded = Buffer.from(captchaInfo.src.split(',')[1], 'base64').toString('utf-8');
        console.log('SVG content:', decoded.substring(0, 1000));
      }
    } else {
      console.log('Captcha URL:', captchaInfo.src);
    }
  }
  
  await browser.close();
})();
