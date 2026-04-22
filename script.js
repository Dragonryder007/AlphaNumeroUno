// Initialize GSAP & ScrollTrigger
gsap.registerPlugin(ScrollTrigger);

// Custom Cursor (Desktop Only)
const cursor = document.querySelector('.cursor');
const follower = document.querySelector('.cursor-follower');
let posX = 0, posY = 0, mouseX = 0, mouseY = 0;

if (window.innerWidth > 768) {
  gsap.to({}, 0.016, {
    repeat: -1,
    onRepeat: function() {
      posX += (mouseX - posX) / 9;
      posY += (mouseY - posY) / 9;
      
      gsap.set(follower, {
        css: { left: posX, top: posY }
      });
      gsap.set(cursor, {
        css: { left: mouseX, top: mouseY }
      });
    }
  });

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // Hover effects on buttons & links
  const links = document.querySelectorAll('a, button, .glass-card');
  links.forEach(link => {
    link.addEventListener('mouseenter', () => {
      gsap.to(cursor, { scale: 0, duration: 0.3 });
      gsap.to(follower, { 
        scale: 1.5, 
        backgroundColor: 'rgba(32, 201, 151, 0.2)', 
        borderColor: 'transparent',
        duration: 0.3 
      });
    });
    link.addEventListener('mouseleave', () => {
      gsap.to(cursor, { scale: 1, duration: 0.3 });
      gsap.to(follower, { 
        scale: 1, 
        backgroundColor: 'transparent', 
        borderColor: 'rgba(32, 201, 151, 0.5)',
        duration: 0.3 
      });
    });
  });
}

// Navbar scroll effect
const navbar = document.querySelector('.navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 50) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
});

// GSAP Animations
document.addEventListener("DOMContentLoaded", (event) => {
  
  // Hero animations
  const heroTimeline = gsap.timeline();
  
  heroTimeline.fromTo(".fade-up", 
    { y: 50, opacity: 0 },
    { y: 0, opacity: 1, duration: 1, stagger: 0.15, ease: "power3.out" }
  );

  heroTimeline.fromTo(".fade-left",
    { x: 100, opacity: 0, rotation: 5 },
    { x: 0, opacity: 1, rotation: 0, duration: 1.2, ease: "power4.out" },
    "-=0.8"
  );
  
  // Scroll animations for service cards
  gsap.utils.toArray('.service-card').forEach((card, i) => {
    gsap.fromTo(card, 
      { y: 50, opacity: 0 },
      {
        y: 0, 
        opacity: 1, 
        duration: 0.8,
        ease: "power3.out",
        scrollTrigger: {
          trigger: card,
          start: "top 85%",
          toggleActions: "play none none reverse"
        }
      }
    );
  });

  // CTA Panel Appears
  gsap.fromTo(".cta-section .glass-panel",
    { scale: 0.9, opacity: 0, y: 50 },
    {
      scale: 1, opacity: 1, y: 0, 
      duration: 1, 
      ease: "power4.out",
      scrollTrigger: {
        trigger: ".cta-section",
        start: "top 75%"
      }
    }
  );
});
