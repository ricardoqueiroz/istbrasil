import { provideZoneChangeDetection } from "@angular/core";
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { CoreModule2 } from './app/core/core.module';

platformBrowserDynamic()
  .bootstrapModule(CoreModule2, { applicationProviders: [provideZoneChangeDetection()], })
  .catch((err) => console.error(err));
