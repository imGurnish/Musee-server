const urls = [
	'https://www.jiosaavn.com/api.php?__call=autocomplete.get&ctx=web6dot0&query=Diljit+Dosanjh&_format=json&_marker=0',
	'https://www.jiosaavn.com/api.php?__call=search.getResults&q=roar+diljit&_format=json&_marker=0&api_version=4&ctx=web6dot0',
	'https://www.jiosaavn.com/api.php?__call=song.getDetails&pids=aRZbUYD7&_format=json',
	'https://www.jiosaavn.com/api.php?__call=content.getAlbumDetails&albumid=14567221&_format=json',
	'https://www.jiosaavn.com/api.php?__call=artist.getArtistPageDetails&artistId=702592&_format=json',
	'https://www.jiosaavn.com/api.php?__call=playlist.getDetails&listid=30793386&_format=json',
];

async function fetchAndPrint(url, index) {
	console.log('\n============================================================');
	console.log(`API ${index + 1}: ${url}`);
	console.log('------------------------------------------------------------');

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				Accept: 'application/json, text/plain, */*',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
			},
		});

		const rawText = await response.text();
		console.log(`Status: ${response.status} ${response.statusText}`);

		try {
			const parsed = JSON.parse(rawText);
			console.log('Result (JSON):');
			console.log(JSON.stringify(parsed, null, 2));
		} catch {
			console.log('Result (Raw Text):');
			console.log(rawText);
		}
	} catch (error) {
		console.error('Request failed:');
		console.error(error.message);
	}
}

async function run() {
	for (let index = 0; index < urls.length; index += 1) {
		await fetchAndPrint(urls[index], index);
	}

	console.log('\nAll API requests completed.');
}

run();