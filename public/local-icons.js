// Simple offline SVG icon replacement for Phosphor icons
document.addEventListener('DOMContentLoaded', () => {
    const iconMap = {
        'ph-x': '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-check-circle': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-caret-down': '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-caret-up': '<path d="M18 15l-6-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-activity': '<path d="M3 12h3l3-9 5 18 3-9h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-spinner-gap': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-dasharray="3.14 10" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle>',
        'ph-play': '<polygon points="5 3 19 12 5 21 5 3" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
        'ph-gauge': '<path d="M3 12a9 9 0 1 1 18 0M12 12l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-gear': '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="2" fill="none"/>',
        'ph-shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-dna': '<path d="M8 3v18M16 3v18M8 6h8M8 12h8M8 18h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-cpu': '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 9h6v6H9zM9 4v-2M15 4v-2M9 22v-2M15 22v-2M4 9h-2M4 15h-2M22 9h-2M22 15h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-identification-card': '<rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="8" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M14 10h4M14 14h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-floppy-disk': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M17 21v-8H7v8M7 3v5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-rocket': '<path d="M4 14l6-6M12 14v7M10 21h4M10 4l6-2 2 6M18 4l-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 10a5 5 0 0 1 0 10 5 5 0 0 1-10 0 5 5 0 0 1 10 0z" stroke="currentColor" stroke-width="2" fill="none"/>',
        'ph-lightning': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
        'ph-file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
        'ph-download-simple': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-target': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="2" fill="currentColor"/>',
        'ph-palette': '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.02 0 2-.9 2-2 0-.52-.2-1.02-.56-1.42a2.035 2.035 0 0 1-.44-1.58C13.25 15.65 14.54 15 16 15h2c2.21 0 4-1.79 4-4 0-4.97-4.48-9-10-9z" stroke="currentColor" stroke-width="2" fill="none"/>',
        'ph-clock-counter-clockwise': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="12 6 12 12 16 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-globe-hemisphere-west': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="2" fill="none"/>',
        'ph-duotone': '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="2" fill="none"/>',
        'ph-wifi-high': '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-trash': '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-copy': '<rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
        'ph-arrows-clockwise': '<polyline points="22 12 18 16 14 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M2.5 12a10 10 0 1 1 1.7 5.6M18 16l3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
    };

    // Replace all elements with class starting with ph-
    const replaceIcons = () => {
        document.querySelectorAll('i[class*="ph-"]').forEach(el => {
            if (el.dataset.iconReplaced) return; // Prevent double replacement
            const classes = Array.from(el.classList);
            let iconName = classes.find(c => c.startsWith('ph-') && c !== 'ph-bold' && c !== 'ph-fill' && c !== 'ph-duotone');
            if (iconName && iconMap[iconName]) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                // Copy classes to SVG
                el.className.split(' ').forEach(c => svg.classList.add(c));
                // Add base sizing
                svg.classList.add('w-[1em]', 'h-[1em]', 'inline-block', 'align-middle');
                
                // For filled icons
                let innerHtml = iconMap[iconName];
                if (classes.includes('ph-fill')) {
                    innerHtml = innerHtml.replace(/fill="none"/g, 'fill="currentColor"').replace(/stroke="currentColor"/g, 'stroke="none"');
                }
                
                svg.innerHTML = innerHtml;
                el.parentNode.replaceChild(svg, el);
                svg.dataset.iconReplaced = "true";
            }
        });
    };

    // Initial replace
    replaceIcons();

    // Observe DOM changes to replace dynamically added icons (e.g., from app.js rendering)
    const observer = new MutationObserver((mutations) => {
        let shouldReplace = false;
        mutations.forEach(m => {
            if (m.addedNodes.length > 0) shouldReplace = true;
        });
        if (shouldReplace) replaceIcons();
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
});
