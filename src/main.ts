import { BootstrapOptions, provideZoneChangeDetection } from '@angular/core';
import { AppComponent } from './app.component';
import { appRoutes } from './app.routes';
import { provideRouter } from '@angular/router';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { providePrimeNG } from 'primeng/config'; // Inclusão
import Aura from '@primeuix/themes/aura';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(appRoutes),
    provideAnimations(),
    providePrimeNG({
      theme: {
        preset: Aura,
        options: {
          darkModeSelector: false   // 🔥 FORÇA LIGHT MODE
        }
      }
    })	
  ]
}).catch((err: unknown) => console.error(err));