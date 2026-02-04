**Subject:** Progress Update & Timeline for GLOQ Massing Tool Enhancements

---

Hi Unduwap,

Thank you for the detailed feedback and feature priorities! I've been making good progress and wanted to share where we stand, along with timeline estimates for the requested enhancements.

---

### **Work Completed (Billable: ~70 hours)**

| Phase                               | Effort (hrs) | Description                                                                                                                                       |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Initial Python Prototype**        | 15           | Sheaf-theoretic massing solver parsing PDFs directly, Pydantic schemas, Matplotlib/SVG visualization                                              |
| **CSV Data Integration**            | 10           | Switched to actual CSV data from your exports for building specs, unit types, parking requirements                                                |
| **Web Viewer (React/TypeScript)**   | 35           | Interactive floor plan viewer with perimeter packing algorithm, floor navigation, collision detection, zoom/pan, unit labels, legend color coding |
| **Map & Environmental Integration** | 5            | Google Maps integration with air quality, pollen, solar, weather APIs                                                                             |
| **Parking Floor Generation**        | 5            | Perpendicular stalls with drive aisles, support rooms (trash, MPOE, fire pump, etc.)                                                              |

**Live Demo:** https://gloq-floorplan-viewer.web.app

---

### **Feature Requests & Timeline Estimates**

Based on your prioritized list:

| Priority | Feature                                   | Estimate  | Notes                                                                                                                            |
| -------- | ----------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **1**    | **Fix P9 Level 4 Overlapping**            | 4-6 hrs   | Adjust stair/unit placement logic, improve collision buffer for corner cases                                                     |
| **2**    | **Corridor Accessibility**                | 8-12 hrs  | Add corridor/hallway generation connecting units to core; requires routing algorithm                                             |
| **3**    | **Organized Parking Aisles**              | 6-8 hrs   | Enhance parking generator with proper aisle spacing, stall dimensions, ingress/egress paths                                      |
| **4**    | **Dynamic Unit Shapes (Non-Rectangular)** | 15-20 hrs | Implement grid-based approach (1 sqft per cell) for L-shaped, corner, and irregular units like in your massing examples          |
| **5**    | **Fit Building to Lot Shape**             | 12-16 hrs | Support trapezoid/irregular lot boundaries, setback constraints, perimeter-aware placement                                       |
| **6**    | **Unit Count Metrics Dashboard**          | 4-6 hrs   | Display target vs. actual units, parking counts (surface/underground/above-ground), space allocation summary                     |
| **7**    | **Multiple Building Shapes**              | 20-30 hrs | Add layout presets: Courtyard (filled center), Donut (central courtyard), H-shape, T-shape - each with distinct generation logic |
| **8**    | **3D/Side Views**                         | 16-24 hrs | Isometric or 3D visualization using Three.js to show multi-floor stacking, building massing                                      |
| **9**    | **CAD/Bluebeam Export**                   | 8-12 hrs  | DXF export for AutoCAD, PDF layers for Bluebeam annotations                                                                      |

---

### **Suggested Phases**

Given the scope, I'd recommend tackling this in phases:

**Phase 1 (Quick Wins) - ~2-3 days**
- Fix P9 overlapping
- Add unit count metrics display  
- Organize parking layout

**Phase 2 (Core Layout Improvements) - ~1 week**
- Corridor/accessibility paths
- Dynamic unit shapes (grid approach)
- Fit to lot boundary

**Phase 3 (Advanced Features) - ~1.5-2 weeks**
- Multiple building shapes (H, T, Donut, Courtyard)
- 3D/isometric views
- CAD/Bluebeam export

---

### **Questions for You**

1. For the **dynamic shapes**, should we allow users to manually adjust unit boundaries, or keep it fully algorithmic?
2. For **building shapes**, do you want preset selection (dropdown) or should users be able to toggle/configure the layout interactively?
3. For **3D views**, is a simple isometric view sufficient, or do you need full 3D rotation/orbit controls?

Happy to jump on a call to discuss priorities or adjust the approach. Let me know if you'd like me to start with Phase 1!

Best,  
Shakil


