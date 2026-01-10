import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { Release, ReleasesService } from '../../../service/releases.service';
import { HttpClientModule } from '@angular/common/http';

@Component({
    selector: 'app-discografia',
    standalone: true,
    imports: [CommonModule, TableModule, ButtonModule, HttpClientModule],
    templateUrl: './discografia.component.html',
    providers: [ReleasesService]
})
export class DiscografiaComponent implements OnInit {
    
    releases!: Release[];
    
    expandedRows: { [key: string]: boolean } = {};

    loading: boolean = true;

    constructor(private releasesService: ReleasesService) {}

    ngOnInit() {
        this.releasesService.getAllReleases().subscribe((data) => {
            this.releases = data;
            this.loading = false;
        });
    }

    onRowExpand(event: any) {
        const release = event.data as Release;
        this.expandedRows[release.id] = true;
        this.loadTracks(release);
    }

    onRowCollapse(event: any) {
        const release = event.data as Release;
        delete this.expandedRows[release.id];
    }

    loadTracks(release: Release) {
        if (release.tracks) {
            // Tracks already loaded
            return;
        }

        this.releasesService.getTracks(release.release_num).subscribe(tracks => {
            release.tracks = tracks;
        });
    }
}
