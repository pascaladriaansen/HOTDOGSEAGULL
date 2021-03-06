// module that allows you to determine if a file is natively supported by the chromecast
// also supports transcoding of a file

// Chromecast Media Player officially supports:
// Video codecs: H.264 High Profile Level 4.1, 4.2 and 5, VP8
// Audio decoding: HE-AAC, LC-AAC, CELT/Opus, MP3, Vorbis
// Image formats: BMP, GIF, JPEG, PNG, WEBP
// Containers: MP4, WebM
//
// Unofficial support:
// Video: h264 level 3.1
// Containers: MKV (webm)

var probe = require('node-ffprobe');
var ffmpeg = require('fluent-ffmpeg');
var path = require('path');
var fs = require('fs');

//cache the responses from reading ff-probe
//based on the mtime of the file 
var probe_cache = {}

//function to cache the results of probe
var probe_check_cache = function(file, callback){
	var stats = fs.statSync(file);

	var append_probe_cache = function(err, probeData){
				if(probeData){
					probe_cache[file] = {}
					probe_cache[file].stats = stats;
					probe_cache[file].probeData = probeData;
				}
				callback(err, probeData)
			}

	if(file in probe_cache){
		if(probe_cache[file].stats.mtime.valueOf() != stats.mtime.valueOf()){
			probe(file, append_probe_cache);
		} else {
			callback(0, probe_cache[file].probeData)
		}
	} else {
		probe(file, append_probe_cache);
	}
}

var get_file_data = function(file, callback){
	//callback is: function(compatibility, data)
	//where data gives specifics about what is and isn't compatible
	//includes the output from ffprobe under ffprobe_data

	probe_check_cache(file, function(err, probeData) {
		var obj = {
			audio: 0,
			video: 0,
			container: 0,
			ffprobe_data: undefined
		}

		//check for subtitles file
		subtitle_file = path.join(path.dirname(file), path.basename(file, path.extname(file)) + ".srt")
		if(fs.existsSync(subtitle_file)){
			obj.subtitle_file = subtitle_file;
		}

		if(probeData == undefined){
			callback(0, obj);
			return
		}
		obj.ffprobe_data = probeData;

		/*console.log("--")
		console.log(probeData)
		console.log("--")*/
		for(i in probeData.streams){
			stream = probeData.streams[i]
			if(stream.codec_type == 'video'){
				if(stream.codec_name == 'h264' 
					&& stream.profile == 'High'
					&& (stream.level == 31 || stream.level == 41 || stream.level == 42 || stream.level == 5 || stream.level == 50)
					){
						obj.video = 1;
						obj.video_transcode = "-vcodec copy"
				} else {
					obj.video_transcode = "-vcodec libx264 -profile:v high -level 5.0"
				}
			}

			if(stream.codec_type == 'audio'){
				if( (stream.codec_name == 'aac' || stream.codec_name == 'mp3' || stream.codec_name == 'vorbis' || stream.codec_name == 'opus') ){
				obj.audio = 1;
				obj.audio_transcode = "-acodec copy"
				} else {
				obj.audio_transcode = "-acodec aac -q:a 100"
				}
			}
		}

		//generate a recommended transcode command
		var output_file = '"' + path.basename(file, path.extname(file)) + '.mp4"'
		obj.transcode_cmd = "ffmpeg -i \"" + path.basename(file) +"\" " + obj.video_transcode + " " + obj.audio_transcode +" "+ output_file

		//ffprobe returns a list of formats that the container might be classified as
		// i.e. for mp4/mov/etc we'll get a string that looks like: 'mov,mp4,m4a,3gp,3g2,mj2'
		if(  probeData.format.format_name.split(",").indexOf("mp4") > -1 || probeData.format.format_name.split(",").indexOf("webm") > -1){
			obj.container = 1;
		}

		compat = 0
		if(obj.audio == 1 && obj.video==1 && obj.container == 1){
			compat = 1;
		}
		callback(compat, obj)
	});	
}

var get_dir_data = function(basedir, dir, return_compat, callback){
	//reads a directory
	//calls callback( files ) with an associative array of files
	//if return_compat is true, it also returns results of get_file_info()
	var response_obj = {}
	var to_check = [];

	real_dir = path.join(basedir, dir)
	files = fs.readdirSync(real_dir);
	files.forEach(function(f){
		var file = path.join(dir, f);
		var file_loc = path.join(basedir, file);

		//fill in information about the file in this dir
		stats = fs.statSync(file_loc);
		response_obj[file] = {
				compatibility_data: undefined,
				compatible: 0,
				is_dir: 0,
				stats: stats
			};

		if(stats && stats.isFile()){
			to_check.push(file);
		} else if ( stats && stats.isDirectory()){
			response_obj[file].is_dir = 1;
		}
	});

	var append_compat = function(file){
			console.log("checking compatbility: basedir: "+basedir+" file: "+file)
			get_file_data(path.join(basedir, file), function(compat, data){
				response_obj[file].compatibility_data = data;
				response_obj[file].compatible = compat;

				if(to_check.length > 0){
					append_compat(to_check.pop());
				} else {
					callback(response_obj);
				}
			});
		};

	if(return_compat && to_check.length > 0){
			append_compat(to_check.pop());
	} else {
		callback(response_obj);
	}
}

var transcode_stream = function(file, res, options, ffmpeg_options, callback){
	/* runs transcoding on file, streaming it out via the res object
	  options provides some functionality:
	  ffmpeg_options should be a string that will get passed directly to ffmpeg (see below)
	  callback(err, ffmpeg_exit_code, ffmpeg_output);will be called when transcode is finished, 
	  	err will be True if there was an error, and error_string will contain whatever ffmpeg complained about

	  supported options:
	  		{
				'use_subtitles' : 0,
				'subtitle_path' : "something.srt" //optional, uses <filename>.srt if not provided
				'audio_track' : 
	  		}
	*/
	res.contentType('video/mp4');

	get_file_data(pathToMovie, function(compat, data){

		opts = ['-strict experimental', data.audio_transcode, data.video_transcode]
		if(options.use_subtitles){
			//todo, need to check if this version of ffmpeg supports subs before enabling
			/*if(data.subtitle_file){ //if there is a valid subtitle file
			opts.push("-vf subtitles=" + data.subtitle_file);
			}*/
		}

		console.log("calling transcode with options: "+opts)
		var proc = new ffmpeg({ source: pathToMovie, nolog: true, timeout: 0 })
		.toFormat('matroska')
		.addOptions( opts )
		//.withVideoCodec('copy')
		//.withAudioCodec('copy')
		// save to stream
		/*.onProgress(function(progress) {
		    console.log(progress);
		  })*/
		.writeToStream(res, function(retcode, ffmpeg_output){
			//console.log('transcoding finished: '+retcode); //+" error: "+error);

			err = 0;
			if(retcode == 255){ 
				//retcode seems like transcoding was terminated early by node, which is fine
			} else if (retcode == 1){
				//genuine error
				err = 1;
			}

			callback(err, retcode, ffmpeg_output);
		});

	});
}

module.exports = {
  get_file_data: get_file_data,
  get_dir_data: get_dir_data,
  transcode_stream : transcode_stream
}
