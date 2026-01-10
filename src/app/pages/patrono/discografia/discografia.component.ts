import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { Release, ReleasesService } from '../../../service/releases.service';

@Component({
    selector: 'app-discografia',
    standalone: true,
    imports: [CommonModule, TableModule],
    templateUrl: './discografia.component.html'
})
export class DiscografiaComponent implements OnInit {
    releases: Release[] = [];

    constructor(private releasesService: ReleasesService) {}

    ngOnInit() {
        this.releasesService.getAllReleases().subscribe({
            next: (data) => {
                this.releases = data;
            },
            error: (err) => {
                console.error('Erro ao carregar discografia', err);
            }
        });
    }
}
