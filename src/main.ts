import { BootstrapOptions, provideZoneChangeDetection } from '@angular/core';
import { AppComponent } from './app.component';
import { appRoutes } from './app.routes';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { providePrimeNG } from 'primeng/config'; // Inclusão
import Aura from '@primeuix/themes/aura';
import { provideHttpClient } from '@angular/common/http';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection(),
    provideHttpClient(),
    provideRouter(
      appRoutes,
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'enabled'
      })
    ),
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
