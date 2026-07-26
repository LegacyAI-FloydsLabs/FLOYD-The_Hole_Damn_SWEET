/**
 * ui-gate.js - Deterministic UI Sanity Validator
 * 
 * This script runs in the browser context via the Floyd Bridge.
 * It calculates hard metrics for layout, contrast, and visibility
 * to prevent "shit UI" from passing automated checks.
 */

(function() {
  function getLuminance(r, g, b) {
    const a = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }

  function getContrast(rgb1, rgb2) {
    const lum1 = getLuminance(...rgb1) + 0.05;
    const lum2 = getLuminance(...rgb2) + 0.05;
    return Math.max(lum1, lum2) / Math.min(lum1, lum2);
  }

  function parseRGB(str) {
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0, 0, 0];
  }

  window.__floydUiGate = {
    audit: function() {
      const results = {
        score: 100,
        verdict: "PASS",
        issues: [],
        metrics: {
          contrast_failures: 0,
          layout_balance: 0, // 0 is perfect, 1 is totally left-justified
          is_blank: false,
          overflow: false
        }
      };

      // 1. Contrast Check (The "Ghost Text" Detector)
      const elements = document.querySelectorAll('h1, h2, h3, h4, p, span, button, a');
      elements.forEach(el => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        
        const fg = parseRGB(style.color);
        // Simplified background check (ideally we'd look at the element behind it)
        const bg = parseRGB(style.backgroundColor === 'transparent' ? 'rgb(0,0,0)' : style.backgroundColor);
        const contrast = getContrast(fg, bg);
        
        if (contrast < 3.0) {
          results.metrics.contrast_failures++;
          results.issues.push(`Low contrast (${contrast.toFixed(2)}:1) on "${el.innerText.substring(0, 20)}..."`);
          results.score -= 5;
        }
      });

      // 2. Layout Balance (The "Left-Third" Detector)
      const viewportWidth = window.innerWidth;
      let leftCount = 0;
      let totalCount = 0;
      
      document.querySelectorAll('div, section, main').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return;
        totalCount++;
        if (rect.right < viewportWidth * 0.5) {
          leftCount++;
        }
      });
      
      results.metrics.layout_balance = leftCount / (totalCount || 1);
      if (results.metrics.layout_balance > 0.8) {
        results.issues.push(`Layout is heavily left-justified (${(results.metrics.layout_balance * 100).toFixed(0)}% of content)`);
        results.score -= 20;
      }

      // 3. Overflow Check
      if (document.documentElement.scrollHeight > window.innerHeight * 1.5) {
        results.metrics.overflow = true;
        results.issues.push("Extreme vertical overflow detected (skyscraper layout)");
        results.score -= 10;
      }

      // 4. Blank Screen Detection
      if (document.body.innerText.length < 50) {
        results.metrics.is_blank = true;
        results.issues.push("Page appears empty or mostly blank");
        results.score = 0;
      }

      if (results.score < 70) results.verdict = "FAIL";
      return results;
    }
  };
})();
