# Memecoin Arena Design System

Reference for building UI consistent with labs.meme.com. All styles are inline React (no CSS framework). Dark theme, gaming aesthetic.

## Fonts (Google Fonts)

```html
<link href="https://fonts.googleapis.com/css2?family=Londrina+Solid:wght@400;900&family=Jersey+25&family=Mulish:wght@400;700&display=swap" rel="stylesheet"/>
```

| Font | Role | Usage |
|------|------|-------|
| `'Londrina Solid', sans-serif` | Display / headings | Titles, coin names, prices, countdown timer, numbers |
| `'Jersey 25', sans-serif` | UI / labels | Buttons, labels, secondary text, stats, body copy |
| `'Mulish', sans-serif` | Body fallback | Root container default font |

### Font Size Scale
- `.6em` — Small labels (field labels like "PRICE TO BEAT")
- `.75em` — Stats, percentages, small indicators
- `.85em` — Sidebar text, leaderboard names, small buttons
- `.9em` — Subtitles, modal body text
- `1em` — Standard button text, inputs
- `1.05em` — Price values, coin header text
- `1.1em` — Timer, notification title, modal title
- `1.3em` — Mobile page title
- `1.6em` — Desktop page title

## Colors

### Backgrounds
| Color | Usage |
|-------|-------|
| `#0c1018` | Page background |
| `#0f1620` | Header background |
| `#191f29` | Card inner, panel headers, sidebar rows |
| `#212936` | Card gradient start |
| `#4e596c` | Card gradient end |
| `#1a2332` | Modal top |

### Text
| Color | Usage |
|-------|-------|
| `#fff` | Primary text |
| `#94a3b8` | Secondary text (muted) |
| `#ffffff60` | Subtitle / dim text |
| `#ffffff40` | Labels, very muted |
| `#ffffff30` | Disabled text |
| `#ffffff80` | Semi-muted (percentage buttons) |

### Accent Colors
| Color | Usage |
|-------|-------|
| `#71BAFF` | Primary blue (UP, main actions) |
| `#4023C3` | Deep purple (secondary actions) |
| `#4ade80` | Green (wins, positive PnL) |
| `#22c55e` | Bright green (success states) |
| `#f65e5e` | Red (losses, negative PnL) |
| `#ef4444` | Bright red (error/loss notifications) |
| `#a78bfa` | Purple (DOWN positions) |
| `#f7931a` | Orange/gold (branding) |

### Borders (white with alpha)
- `#ffffff0d` — Subtle dividers
- `#ffffff08` — Row separators
- `#ffffff15` — Light borders
- `#ffffff4d` — Visible borders (probability bar)

## Key Style Constants

### Gold Gradient (`gld`) — Brand Signature
```javascript
const gld = {
  background: "linear-gradient(193deg,#f7931a -49%,#fab248 -14%,#fff1a6 58%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  backgroundClip: "text"
};
```
Used on: timer, prices, pool values, balance display, branding text, cashtag links.

### Gradients
```javascript
// Card / panel outer wrapper
"linear-gradient(360deg,#212936,#4e596c)"

// Modal background
"linear-gradient(180deg,#1a2332,#0c1018)"

// Primary action button (deposit, etc.)
"linear-gradient(90deg,#71BAFF,#4023C3)"

// Probability bar — UP side
"linear-gradient(270deg,#FFFAC0 4%,#AED8FF 25%,#71BAFF 62%)"

// Probability bar — DOWN side
"linear-gradient(90deg,#8398FF 25%,#4023C3 62%)"

// Win notification
"linear-gradient(135deg, #22c55e, #16a34a)"

// Loss notification
"linear-gradient(135deg, #ef4444, #dc2626)"

// Current user avatar ring
"linear-gradient(135deg,#71BAFF,#4023C3)"
```

## Component Patterns

### Card (Market Card)
```jsx
// Outer wrapper
<div style={{
  background: "linear-gradient(360deg,#212936,#4e596c)",
  boxShadow: "0 4px 44px #ffffff12,0 4px 12px #000000b8",
  borderRadius: "16px 16px 25px 25px",
  padding: "5px 6px 10px"
}}>
  // Inner content
  <div style={{
    background: "#191f29",
    borderRadius: 14,
    padding: "14px 18px",
    minHeight: 192,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between"
  }}>
    {/* content */}
  </div>
</div>
```

### Button Base
```javascript
const bx = {
  height: 38,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  fontFamily: "'Jersey 25',sans-serif",
  fontSize: "1em",
  textTransform: "uppercase",
  borderRadius: 15,
  cursor: "pointer",
  border: "none",
  color: "#fff"
};
```

**Button variants (apply via `...bx` spread):**
| Variant | Style |
|---------|-------|
| Primary (UP) | `background: "#71baff8a"` |
| Secondary (DOWN) | `background: "#234bc29e", border: "2px solid #c8dbff52"` |
| Solid action | `background: "#71baff"` |
| Gradient CTA | `background: "linear-gradient(90deg,#71BAFF,#4023C3)"` |
| Destructive | `background: "#f65e5e30"` |
| Cancel/back | `background: "#00000042"` |
| Disabled | Add `opacity: 0.5, cursor: "not-allowed"` |

### Input Field
```javascript
{
  height: 42,
  border: "1px solid #4c5159",
  borderRadius: 15,
  textAlign: "center",
  color: "#fff",
  background: "transparent",
  fontFamily: "'Jersey 25',sans-serif",
  fontSize: "1em",
  outline: "none",
  width: "100%",
  boxSizing: "border-box"
}
// Add: inputMode="numeric", pattern="[0-9]*" for number inputs
```

### Sidebar Panel
```jsx
<div style={{
  background: "linear-gradient(360deg,#212936,#4e596c)",
  borderRadius: 25,
  overflow: "hidden"
}}>
  {/* Panel header */}
  <div style={{
    padding: "12px 16px",
    fontFamily: "'Londrina Solid',sans-serif",
    textTransform: "uppercase",
    background: "#191f29",
    borderBottom: "1px solid #ffffff0d"
  }}>TITLE</div>

  {/* Row */}
  <div style={{
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    background: "#191f29",
    borderBottom: "1px solid #ffffff08"
  }}>
    {/* row content */}
  </div>
</div>
```

### Modal / Overlay
```jsx
// Backdrop
<div style={{
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.8)",
  display: "flex",
  alignItems: isMobile ? "flex-end" : "center",
  justifyContent: "center",
  zIndex: 100
}}>
  {/* Panel */}
  <div style={{
    background: "linear-gradient(180deg,#1a2332,#0c1018)",
    borderRadius: isMobile ? "20px 20px 0 0" : 20,
    padding: isMobile ? "24px 16px 32px" : 32,
    width: isMobile ? "100%" : "auto",
    minWidth: isMobile ? "auto" : 340,
    maxWidth: isMobile ? "100%" : 400,
    border: "1px solid #ffffff15",
    textAlign: "center"
  }}>
    {/* modal content */}
  </div>
</div>
```

### Notification Toast
```jsx
<div style={{
  position: "fixed",
  top: 20,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1000,
  padding: "16px 24px",
  borderRadius: 16,
  background: isSuccess
    ? "linear-gradient(135deg, #22c55e, #16a34a)"
    : "linear-gradient(135deg, #ef4444, #dc2626)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  gap: 12,
  animation: "slideDown 0.3s ease-out"
}}>
```

### Coin Image
```jsx
<div style={{
  width: 40, height: 40, borderRadius: 12,
  border: `1px solid ${color}66`,
  background: `linear-gradient(135deg, ${color}44, ${color}11)`,
  overflow: "hidden", flexShrink: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'Londrina Solid',sans-serif",
  fontSize: 18, color: "#fff", fontWeight: 900,
  textShadow: "0 1px 3px rgba(0,0,0,.4)"
}}>
  <img src={src} style={{
    position: "absolute", inset: 0,
    width: "100%", height: "100%", objectFit: "cover", borderRadius: 11
  }}/>
</div>
```

## Layout

### Responsive Breakpoint
Single breakpoint: **1000px** (`window.innerWidth < 1000` = mobile)

### Page Structure
```jsx
// Root
<div style={{
  minHeight: "100vh",
  background: "#0c1018",
  color: "#fff",
  fontFamily: "'Mulish',sans-serif"
}}>
  {/* Header — sticky */}
  <div style={{
    background: "#0f1620",
    position: "sticky", top: 0, zIndex: 10,
    padding: isMobile ? "10px 12px" : "12px 24px",
    borderBottom: "1px solid #ffffff0d",
    display: "flex", justifyContent: "space-between", alignItems: "center"
  }}/>

  {/* Main content */}
  <div style={{
    maxWidth: "72em",
    margin: "0 auto",
    padding: isMobile ? "12px 12px 24px" : "20px 2.5% 48px"
  }}>
    {/* Desktop: grid with sidebar. Mobile: flex column */}
    <div style={{
      display: isMobile ? "flex" : "grid",
      flexDirection: isMobile ? "column" : undefined,
      gridTemplateColumns: isMobile ? undefined : "1fr 20em",
      gap: 20,
      alignItems: "start"
    }}>
      {/* Cards grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(17em, 1fr))",
        gap: isMobile ? 12 : 16
      }}/>

      {/* Sidebar — sticky on desktop */}
      <div style={{
        position: isMobile ? "static" : "sticky",
        top: isMobile ? undefined : 60,
        display: "flex", flexDirection: "column", gap: 16
      }}/>
    </div>
  </div>
</div>
```

## Animations (CSS keyframes)

```css
@keyframes slideDown {
  from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

@keyframes timerPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

@keyframes priceFlash {
  0% { opacity: 1; transform: scale(1.2); }
  30% { opacity: 1; transform: scale(1); }
  100% { opacity: 1; transform: scale(1); }
}
```

```css
/* Hide number input spinners */
input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none; margin: 0;
}
input[type=number] { -moz-appearance: textfield; }
```

## Shadows

| Type | Value |
|------|-------|
| Card | `0 4px 44px #ffffff12, 0 4px 12px #000000b8` |
| Notification | `0 8px 32px rgba(0,0,0,0.4)` |
| Title text | `0 2px 4px rgba(0,0,0,.5)` |
| Card header text | `0 2px 2px rgba(0,0,0,.25), 0 6px 6px rgba(0,0,0,.25)` |

## Border Radius Scale
- `5px` — Small badges
- `8px` — Percentage buttons, small indicators
- `12px` — Coin images, header buttons
- `14px` — Card inner content
- `15px` — Buttons, input fields
- `16px` — Cards, notifications
- `20px` — Modals
- `25px` — Sidebar panels, card bottom corners
- `62px` — Pill shapes (probability bar)

## Rank Colors (Leaderboard)
| Position | Color |
|----------|-------|
| 1st | `#f7931a` (gold) |
| 2nd | `#94a3b8` (silver) |
| 3rd | `#b45309` (bronze) |
| 4th+ | `#ffffff40` (muted) |

## Z-Index Layers
| Layer | Z-Index |
|-------|---------|
| Header | `10` |
| Modal overlay | `100` |
| Notification toast | `1000` |

## Text Conventions
- All labels: `textTransform: "uppercase"`
- Font for headings: Londrina Solid
- Font for everything else: Jersey 25
- Positive values: `#4ade80` (green), prefix with `+`
- Negative values: `#f65e5e` (red)
- Arrows: `▲` (up), `▼` (down)
- Gold gradient (`gld`) for emphasis on key values
